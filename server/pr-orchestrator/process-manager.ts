import { isDeepStrictEqual } from "node:util";
import { resolveForRepo } from "./config.ts";
import type { ConnectorRegistry } from "./connectors/registry.ts";
import { factsOf } from "./facts.ts";
import { deriveState, isLegal } from "./machine.ts";
import { evaluate } from "./policy.ts";
import type { PayloadTrigger } from "./payloads.ts";
import { fold, foldAll, payloadOf, PROJECTION_VERSION, prSubjectOf, triggerOf } from "./projection.ts";
import {
  APPROVE_ANSWER, applyIntents, ensureConfigVersion, finishedInput, payloadHead, roundTrip, type IntentHost, type StepDeps, type StepResult,
} from "./step-intents.ts";
import { createSubjectStep } from "./subject-step.ts";
import {
  prKey as makePrKey,
  type AcceptItem, type CommandRecord, type CommandResult, type CoreInput, type IntakeSink, type LedgerEntry, type OmbEvent, type Owner,
  type PrKey, type PrRecord, type Provider, type SubjectKey, type TimerRecord, type TriggerName,
} from "./types.ts";

export type { StepResult } from "./step-intents.ts";
export type { EvaluationInfo } from "./step-intents.ts";

const MAX_STEPS = 8;
const DRAIN_LIMIT = 100;
const SUBJECT_PREFIX = "subject:";

export interface ProcessManagerDeps extends StepDeps {
  /** The connector registry (BUILT_IN_CONNECTORS in production; tests may add fakes). */
  connectors: ConnectorRegistry;
}

export interface ProcessManager extends IntakeSink {
  drain(limit?: number): number;
  apply(prKey: PrKey, input: CoreInput): StepResult;
  bindOwner(owner: Owner, pr: { provider: Provider; repo: string; number: number; url: string | null }): StepResult;
  /** A guarded run ended (from a workflow runtime adapter, later). */
  runFinished(prKey: PrKey, done: { target: string; runRef: string; outcome: "completed" | "failed" | "cancelled" }): StepResult;
  answer(subjectKey: SubjectKey, decisionId: string, answer: string): StepResult;
  fireTimer(timer: TimerRecord): StepResult;
  finishCommand(command: CommandRecord, result: CommandResult): StepResult;
  /** The PR keys whose stored record differs from the refolded ledger. */
  verifyProjection(): PrKey[];
  rebuildProjection(): number;
  /** true when it rebuilt */
  ensureProjectionVersion(): boolean;
  reprocess(status: "failed"): number;
}

export class UnknownPrError extends Error {
  constructor(key: string) {
    super(`unknown PR ${key}`);
    this.name = "UnknownPrError";
  }
}

interface Queued extends PayloadTrigger { own: boolean }

const isEnded = (record: PrRecord) => record.state === "merged" || record.state === "closed";
const isSubjectKey = (key: SubjectKey) => key.startsWith(SUBJECT_PREFIX);

function isReopen(input: CoreInput): boolean {
  return input.type === "event.received" && input.event.type === "pr.opened" && payloadOf(input.event, "pr.opened").reopened === true;
}

function identityOf(input: CoreInput): { provider: Provider; repo: string } | null {
  if (input.type === "owner.bound") return input.pr;
  if (input.type !== "event.received") return null;
  const subject = prSubjectOf(input.event);
  return subject ? { provider: subject.forge, repo: subject.repo } : null;
}

export function createProcessManager(deps: ProcessManagerDeps): ProcessManager {
  const { store } = deps;
  const subjectStep = createSubjectStep(deps);

  function applyInner(subjectKey: PrKey, input: CoreInput): StepResult {
    const now = deps.now();
    const loaded = deps.config();
    ensureConfigVersion(deps, loaded, now);
    const before = store.getPr(subjectKey);
    const identity = before ?? identityOf(input);
    if (identity === null) throw new UnknownPrError(subjectKey);
    const ctx = { now, config: resolveForRepo(loaded.config, identity.provider, identity.repo), configVersion: loaded.version };

    let record: PrRecord | null = before;
    let appended = 0;
    const append = (entry: LedgerEntry, causationSeq: number | null): number => {
      const row = { subjectKey, at: now, configVersion: loaded.version, causationSeq, entry: roundTrip(entry) };
      const seq = store.append(row);
      record = fold(record, { ...row, seq });
      appended += 1;
      return seq;
    };
    const current = () => record as PrRecord;
    const inputSeq = append(input, null);
    const queue: Queued[] = [{ name: triggerOf(input) as TriggerName, entry: input, seq: inputSeq, own: true }];
    const out = { commands: [] as string[], timers: [] as string[] };

    const finishHeld = (held: CommandRecord, reason: string) => {
      const result: CommandResult = { outcome: "skipped", reason };
      store.finishCommand(held.id, result, now);
      const entry = finishedInput(held, result);
      queue.push({ name: "command.finished", entry, seq: append(entry, inputSeq), own: false });
    };
    const dropHeld = () => {
      for (const held of store.awaitingFor(subjectKey)) {
        const head = payloadHead(held.payload);
        if (isEnded(current())) finishHeld(held, "PR ended");
        else if (head !== null && head !== current().headSha) finishHeld(held, "head moved");
      }
    };

    if ((before !== null && before.headSha !== current().headSha) || isEnded(current())) dropHeld();
    if (input.type === "person.answered") {
      const held = store.commandAwaiting(input.decisionId);
      if (held && held.subjectKey === subjectKey) {
        const head = payloadHead(held.payload);
        if (isEnded(current())) finishHeld(held, "PR ended");
        else if (head !== null && head !== current().headSha) finishHeld(held, "head moved");
        else if (APPROVE_ANSWER.test(input.answer.trim())) {
          store.releaseCommand(held.id, now);
          const entry = { type: "command.issued", commandId: held.id, command: held.type, routineId: held.routineId, payload: held.payload } as const;
          queue.push({ name: "command.issued", entry, seq: append(entry, inputSeq), own: false });
        } else finishHeld(held, "rejected by the person");
      }
    }

    const endTrigger = queue[0].name === "pr.merged" || queue[0].name === "pr.closed";
    if (isEnded(current()) && !endTrigger && !isReopen(input)) queue.length = 0;

    const host: IntentHost = {
      store, now, newId: deps.newId, log: deps.log, subjectKey, ctx, record: current, before,
      append: (entry, causationSeq) => append(entry, causationSeq),
      queueIssued: (entry, seq) => { queue.push({ name: "command.issued", entry, seq, own: false }); },
    };

    let processed = 0;
    let first = before === null;
    while (queue.length > 0) {
      if (processed === MAX_STEPS) {
        append({ type: "transition.refused", from: current().state, to: current().state, trigger: "loop_cap" }, inputSeq);
        break;
      }
      processed += 1;
      const item = queue.shift() as Queued;
      const from = first ? null : current().state;
      const target = deriveState(current(), item, ctx);
      if (first || target !== from) {
        if (isLegal(from, target)) append({ type: "state.changed", from, to: target, trigger: item.name }, item.seq);
        else {
          append({ type: "transition.refused", from, to: target, trigger: item.name }, item.seq);
          deps.log(`pr-orchestrator: refused ${from ?? "new"} → ${target} on ${item.name} for ${subjectKey}`);
        }
      }
      first = false;

      let routines = ctx.config.routines;
      if (isEnded(current())) {
        if (!item.own || (item.name !== "pr.merged" && item.name !== "pr.closed")) continue;
        routines = routines.filter(routine => routine.when.on.includes(item.name));
      }
      const event = item.entry.type === "event.received" ? item.entry.event : null;
      const facts = factsOf({ record: current(), previousState: from, trigger: item, ctx });
      const evaluated = evaluate({
        routines, trigger: item.name, connector: event?.connector ?? null, provider: current().provider, repo: current().repo, event, facts,
        config: ctx.config, triggerSeq: item.seq, subjectKey, headSha: current().headSha,
      });
      deps.onEvaluate?.({ prKey: subjectKey, trigger: item.name, triggerSeq: item.seq, facts, intents: evaluated.intents, matched: evaluated.matched });
      const done = applyIntents(host, item, evaluated);
      out.commands.push(...done.commands);
      out.timers.push(...done.timers);
    }

    if (isEnded(current())) dropHeld();
    store.putPr(current());
    if (out.commands.length > 0 || out.timers.length > 0) deps.onWork?.();
    return { prKey: subjectKey, state: current().state, appended, commands: out.commands, timers: out.timers };
  }

  const apply = (subjectKey: PrKey, input: CoreInput): StepResult => store.transaction(() => applyInner(subjectKey, input));

  const route = (subjectKey: SubjectKey, input: CoreInput): StepResult =>
    isSubjectKey(subjectKey) ? subjectStep.input(subjectKey, input) : apply(subjectKey, input);

  function finishCommand(command: CommandRecord, result: CommandResult): StepResult {
    return store.transaction(() => {
      store.finishCommand(command.id, result, deps.now());
      const step = route(command.subjectKey, finishedInput(command, result));
      const { payload } = command;
      if (payload.type === "AskPerson" && payload.gated && result.outcome !== "succeeded") {
        const held = store.getCommand(payload.gated.commandId);
        if (held?.status === "awaiting_approval") return finishCommand(held, { outcome: "skipped", reason: `approval not asked: ${result.reason}` });
      }
      return step;
    });
  }

  const prSubjectKeys = () => store.ledgerKeys().filter(key => !isSubjectKey(key));
  const refolded = (key: PrKey): PrRecord | null => {
    const record = foldAll(store.ledger(key));
    return record === null ? null : roundTrip(record);
  };

  function rebuildProjection(): number {
    return store.transaction(() => {
      let count = 0;
      for (const key of prSubjectKeys()) {
        const record = refolded(key);
        if (record === null) continue;
        store.putPr(record);
        count += 1;
      }
      return count;
    });
  }

  return {
    accept(items: AcceptItem[], now: number) {
      const added = store.insertReceived(items.map(({ event }) => ({
        eventId: event.key, connector: event.connector, subjectKey: event.subjectKey, subjectKind: event.subject.kind, kind: event.type,
        receivedAt: now, occurredAt: event.occurredAt, status: "pending" as const, reason: null, json: JSON.stringify(event),
      })));
      deps.onWork?.();
      return { stored: added.length, duplicates: items.length - added.length };
    },

    drain(limit = DRAIN_LIMIT) {
      const rows = store.receivedByStatus("pending", limit);
      for (const row of rows) {
        try {
          store.transaction(() => {
            const event = JSON.parse(row.json) as OmbEvent;
            event.rawRef = { receivedSeq: row.seq };
            if (prSubjectOf(event)) apply(event.subjectKey, { type: "event.received", event, receivedSeq: row.seq });
            else subjectStep.apply(event.subjectKey, event);
            store.setReceivedStatus(row.seq, "applied", null);
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          store.setReceivedStatus(row.seq, "failed", reason);
          deps.log(`pr-orchestrator: event ${row.eventId} failed: ${reason}`);
        }
      }
      if (store.receivedByStatus("pending", 1).length > 0) deps.onWork?.();
      return rows.length;
    },

    apply,
    bindOwner: (owner, pr) => apply(makePrKey(pr.provider, pr.repo, pr.number), { type: "owner.bound", owner, pr }),
    runFinished: (key, done) => apply(key, { type: "run.finished", ...done }),
    answer: (subjectKey, decisionId, answer) => route(subjectKey, { type: "person.answered", decisionId, answer }),

    fireTimer(timer) {
      return store.transaction(() => {
        const live = store.timersFor(timer.subjectKey).find(candidate => candidate.id === timer.id);
        if (live?.state !== "armed") {
          return { prKey: timer.subjectKey, state: store.getPr(timer.subjectKey)?.state ?? null, appended: 0, commands: [], timers: [] };
        }
        store.setTimerState(timer.id, "fired");
        return apply(timer.subjectKey, { type: "timer.fired", timerId: timer.id, kind: timer.kind });
      });
    },

    finishCommand,

    verifyProjection: () => prSubjectKeys().filter(key => !isDeepStrictEqual(refolded(key), store.getPr(key))),
    rebuildProjection,
    ensureProjectionVersion() {
      if (store.meta("projection_version") === String(PROJECTION_VERSION)) return false;
      store.transaction(() => {
        rebuildProjection();
        store.setMeta("projection_version", String(PROJECTION_VERSION));
      });
      return true;
    },

    reprocess() {
      let count = 0;
      for (let rows = store.receivedByStatus("failed", 500); rows.length > 0; rows = store.receivedByStatus("failed", 500)) {
        store.transaction(() => { for (const row of rows) store.setReceivedStatus(row.seq, "pending", null); });
        count += rows.length;
      }
      if (count > 0) deps.onWork?.();
      return count;
    },
  };
}
