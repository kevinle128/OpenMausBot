import { ACTION_REGISTRY, checkAction } from "./actions.ts";
import { canonicalJson } from "./config.ts";
import { buildPayload, resolveParams, type PayloadTrigger } from "./payloads.ts";
import { readiness } from "./readiness.ts";
import type { OrchestratorStore } from "./store.ts";
import type {
  CommandRecord, CommandResult, CoreInput, DecisionEntry, FactMap, Intent, LedgerEntry, OrchestratorConfig, PrRecord,
  StepContext, SubjectKey, TimerRecord, TriggerName,
} from "./types.ts";

export interface EvaluationInfo {
  prKey: SubjectKey; trigger: TriggerName; triggerSeq: number; facts: FactMap; intents: Intent[]; matched: string[];
}

export interface StepDeps {
  store: OrchestratorStore;
  config(): { config: OrchestratorConfig; version: string; error: string | null };
  now(): number;
  newId(): string;
  log(line: string): void;
  /** The scheduler's poke: new pending rows, commands or timers. */
  onWork?(): void;
  /** Called after each evaluation with the facts and the intents; the routine test run uses it. */
  onEvaluate?(info: EvaluationInfo): void;
}

export interface StepResult {
  prKey: SubjectKey;
  state: PrRecord["state"] | null;
  appended: number;
  commands: string[];
  timers: string[];
}

export const APPROVE_ANSWER = /^(approve|yes)$/i;
export const MS_PER_MINUTE = 60_000;

export function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function ensureConfigVersion(deps: StepDeps, loaded: { config: OrchestratorConfig; version: string }, now: number): void {
  if (deps.store.configVersion(loaded.version) === null) deps.store.saveConfigVersion(loaded.version, canonicalJson(loaded.config), now);
}

export function payloadHead(payload: CommandRecord["payload"]): string | null {
  switch (payload.type) {
    case "Merge": return payload.expectedHeadSha;
    case "RefreshDetails": return payload.headSha;
    case "TellOwner": case "RunWorkflow": case "RunInstruction": return payload.headSha;
    default: return null;
  }
}

export interface IntentHost {
  store: OrchestratorStore;
  now: number;
  newId(): string;
  log(line: string): void;
  subjectKey: SubjectKey;
  ctx: StepContext;
  record(): PrRecord | null;
  before: PrRecord | null;
  append(entry: DecisionEntry, causationSeq: number): number;
  queueIssued(entry: Extract<LedgerEntry, { type: "command.issued" }>, seq: number): void;
}

type ActionLine = Extract<DecisionEntry, { type: "routine.matched" }>["actions"][number];
const NEEDS_PR = "needs a PR subject";

function insertTimer(host: IntentHost, intent: Intent, kind: TimerRecord["kind"], minutes: number, trigger: PayloadTrigger): string | null {
  const timer: TimerRecord = {
    id: host.newId(), subjectKey: host.subjectKey, kind, idemKey: intent.idemKey as string,
    dueAt: host.now + minutes * MS_PER_MINUTE, createdAt: host.now, state: "armed", payload: { routineId: intent.routineId },
  };
  if (!host.store.insertTimer(timer)) return null;
  host.append({ type: "timer.scheduled", timerId: timer.id, kind, dueAt: timer.dueAt, routineId: intent.routineId }, trigger.seq);
  return timer.id;
}

function issue(host: IntentHost, command: CommandRecord, trigger: PayloadTrigger): void {
  const entry = { type: "command.issued", commandId: command.id, command: command.type, routineId: command.routineId, payload: command.payload } as const;
  host.queueIssued(entry, host.append(entry, trigger.seq));
}

function issueCommand(
  host: IntentHost, intent: Intent, action: Extract<Intent["action"], { do: string }>, trigger: PayloadTrigger,
): { line: ActionLine; commands: string[] } | { line: null; commands: [] } {
  const label = action.do;
  const skipped = (reason: string) => ({ line: { action: label, idemKey: intent.idemKey, result: "skipped", reason } as ActionLine, commands: [] as [] });
  const checked = checkAction(action);
  if (!checked.ok) return skipped(checked.error);
  const definition = ACTION_REGISTRY[action.do];
  const record = host.record();
  // Resolved first: a { config } target that names the owner needs a PR as much as a written one.
  const resolved = resolveParams(checked.params, host.ctx.config);
  if (definition.subjects(resolved) === "pr" && record === null) return skipped(NEEDS_PR);
  if (record !== null && definition.guard) {
    const target = definition.guard(resolved);
    if (record.activeRuns[target]) return skipped(`a run of ${target} is active`);
  }
  const built = buildPayload({ action, params: checked.params, record, before: host.before, trigger, ctx: host.ctx, prKey: host.subjectKey });
  if ("skip" in built) {
    host.log(`pr-orchestrator: ${label} not issued for ${host.subjectKey}: ${built.skip}`);
    return { line: null, commands: [] };
  }
  const idemKey = intent.idemKey as string;
  const command: CommandRecord = {
    id: host.newId(), subjectKey: host.subjectKey, type: definition.command, routineId: intent.routineId, idemKey,
    status: "pending", outcome: null, approvalId: null, attempts: 0, nextAt: host.now, createdAt: host.now, updatedAt: host.now,
    payload: built, result: null, lastError: null,
  };
  if (!action.askFirst) {
    if (!host.store.insertCommand(command)) return { line: null, commands: [] };
    issue(host, command, trigger);
    return { line: { action: label, idemKey, result: "issued", commandId: command.id }, commands: [command.id] };
  }
  const approvalId = `${idemKey}#approve`;
  if (!host.store.insertCommand({ ...command, status: "awaiting_approval", approvalId })) return { line: null, commands: [] };
  host.append({ type: "command.gated", commandId: command.id, command: command.type, routineId: intent.routineId, payload: built, decisionId: approvalId }, trigger.seq);
  const ask: CommandRecord = {
    ...command, id: host.newId(), type: "AskPerson", idemKey: `${idemKey}|ask`,
    payload: {
      type: "AskPerson", kind: "approve_action", decisionId: approvalId, gaps: record === null ? [] : readiness(record, host.ctx).gaps,
      gated: { commandId: command.id, command: command.type, summary: definition.describe(resolved) },
    },
  };
  host.store.insertCommand(ask);
  issue(host, ask, trigger);
  return { line: { action: label, idemKey, result: "gated", commandId: command.id }, commands: [command.id, ask.id] };
}

export function applyIntents(
  host: IntentHost, trigger: PayloadTrigger, evaluated: { intents: Intent[]; skipped: Array<{ routineId: string; reason: string }> },
): { commands: string[]; timers: string[] } {
  const lines = new Map<string, ActionLine[]>();
  const out = { commands: [] as string[], timers: [] as string[] };
  const add = (routineId: string, line: ActionLine) => lines.set(routineId, [...(lines.get(routineId) ?? []), line]);
  for (const intent of evaluated.intents) {
    const { action } = intent;
    if ("do" in action) {
      const done = issueCommand(host, intent, action, trigger);
      if (done.line) add(intent.routineId, done.line);
      out.commands.push(...done.commands);
    } else if ("schedule" in action) {
      const label = `schedule:${action.schedule}`;
      if (host.record() === null) add(intent.routineId, { action: label, idemKey: intent.idemKey, result: "skipped", reason: NEEDS_PR });
      else if (typeof action.afterMinutes === "number") {
        const id = insertTimer(host, intent, action.schedule, action.afterMinutes, trigger);
        if (id !== null) {
          out.timers.push(id);
          add(intent.routineId, { action: label, idemKey: intent.idemKey, result: "scheduled" });
        }
      }
    } else {
      const label = `cancel:${action.cancel}`;
      if (host.record() === null) add(intent.routineId, { action: label, idemKey: null, result: "skipped", reason: NEEDS_PR });
      else {
        const armed = host.store.armedTimers(host.subjectKey, action.cancel === "all" ? undefined : action.cancel);
        for (const timer of armed) {
          host.store.setTimerState(timer.id, "cancelled");
          host.append({ type: "timer.cancelled", timerId: timer.id, kind: timer.kind, routineId: intent.routineId }, trigger.seq);
        }
        if (armed.length > 0) add(intent.routineId, { action: label, idemKey: null, result: "cancelled" });
      }
    }
  }
  for (const item of evaluated.skipped) add(item.routineId, { action: "schedule", idemKey: null, result: "skipped", reason: item.reason });
  for (const [routineId, actions] of lines) {
    host.append({ type: "routine.matched", routineId, trigger: trigger.name, triggerSeq: trigger.seq, actions }, trigger.seq);
  }
  return out;
}

export function finishedInput(command: Pick<CommandRecord, "id" | "type" | "payload">, result: CommandResult): Extract<CoreInput, { type: "command.finished" }> {
  return { type: "command.finished", commandId: command.id, command: command.type, payload: command.payload, result };
}

