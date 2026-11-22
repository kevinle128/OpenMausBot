import { resolveRoutines } from "./config.ts";
import { evaluate } from "./policy.ts";
import { factsOf } from "./facts.ts";
import { triggerOf } from "./projection.ts";
import {
  APPROVE_ANSWER, applyIntents, ensureConfigVersion, roundTrip, type IntentHost, type StepDeps, type StepResult,
} from "./step-intents.ts";
import type { CommandRecord, CoreInput, LedgerEntry, OmbEvent, OrchestratorConfig, RepoConfig, StepContext, SubjectKey } from "./types.ts";

export function subjectConfig(config: OrchestratorConfig): RepoConfig {
  const { overrides: _overrides, routines: _routines, ...rest } = config;
  return { ...rest, routines: resolveRoutines(config) };
}

export interface SubjectStep {
  apply(subjectKey: SubjectKey, event: OmbEvent): StepResult;
  input(subjectKey: SubjectKey, input: CoreInput): StepResult;
}

export function createSubjectStep(deps: StepDeps): SubjectStep {
  const { store } = deps;

  function step(subjectKey: SubjectKey, input: CoreInput): StepResult {
    return store.transaction(() => {
      const now = deps.now();
      const loaded = deps.config();
      ensureConfigVersion(deps, loaded, now);
      const ctx: StepContext = { now, config: subjectConfig(loaded.config), configVersion: loaded.version };
      let appended = 0;
      const append = (entry: LedgerEntry, causationSeq: number | null): number => {
        appended += 1;
        return store.append({ subjectKey, at: now, configVersion: loaded.version, causationSeq, entry: roundTrip(entry) });
      };
      const inputSeq = append(input, null);

      let released: string | null = null;
      if (input.type === "person.answered") {
        const held = store.commandAwaiting(input.decisionId);
        if (held && held.subjectKey === subjectKey && answerHeld(held, input.answer, inputSeq, now, append)) released = held.id;
      }

      const name = triggerOf(input) as string;
      const trigger = { name, entry: input as LedgerEntry, seq: inputSeq };
      const facts = factsOf({ record: null, previousState: null, trigger, ctx });
      if (input.type === "command.finished") {
        facts["trigger.command.type"] = input.command;
        facts["trigger.command.outcome"] = input.result.outcome;
        facts["trigger.command.reason"] = input.result.outcome === "succeeded" ? null : input.result.reason;
      }
      if (input.type === "person.answered") facts["trigger.answer.kind"] = answerKind(subjectKey, input.decisionId, inputSeq);
      const event = input.type === "event.received" ? input.event : null;
      const evaluated = evaluate({
        routines: ctx.config.routines, trigger: name, connector: event?.connector ?? null, provider: null, repo: null, event, facts,
        config: ctx.config, triggerSeq: inputSeq, subjectKey, headSha: null,
      });
      deps.onEvaluate?.({ prKey: subjectKey, trigger: name, triggerSeq: inputSeq, facts, intents: evaluated.intents, matched: evaluated.matched });
      const host: IntentHost = {
        store, now, newId: deps.newId, log: deps.log, subjectKey, ctx, record: () => null, before: null,
        append: (entry, causationSeq) => append(entry, causationSeq), queueIssued: () => {},
      };
      const out = applyIntents(host, trigger, evaluated);
      if (released !== null) out.commands.unshift(released);
      if (out.commands.length > 0) deps.onWork?.();
      return { prKey: subjectKey, state: null, appended, commands: out.commands, timers: out.timers };
    });

    /** The kind of the card that was shown for the decision, as lastAnswer.kind gives it on a PR: null once it was answered. */
    function answerKind(subjectKey: SubjectKey, decisionId: string, inputSeq: number): string | null {
      const answeredBefore = store.ledger(subjectKey).some(row => row.seq !== inputSeq && row.entry.type === "person.answered" && row.entry.decisionId === decisionId);
      if (answeredBefore) return null;
      const card = store.commandsFor(subjectKey).find(command =>
        command.payload.type === "AskPerson" && command.payload.decisionId === decisionId && command.outcome === "succeeded");
      return card?.payload.type === "AskPerson" ? card.payload.kind : null;
    }

    /** Returns true when the answer released the held command to run. */
    function answerHeld(
      held: CommandRecord, answer: string, inputSeq: number, now: number, append: (entry: LedgerEntry, causationSeq: number | null) => number,
    ): boolean {
      if (APPROVE_ANSWER.test(answer.trim())) {
        store.releaseCommand(held.id, now);
        append({ type: "command.issued", commandId: held.id, command: held.type, routineId: held.routineId, payload: held.payload }, inputSeq);
        return true;
      }
      const result = { outcome: "skipped", reason: "rejected by the person" } as const;
      store.finishCommand(held.id, result, now);
      append({ type: "command.finished", commandId: held.id, command: held.type, payload: held.payload, result }, inputSeq);
      return false;
    }
  }

  return {
    apply: (subjectKey, event) => step(subjectKey, { type: "event.received", event, receivedSeq: event.rawRef?.receivedSeq ?? 0 }),
    input: step,
  };
}
