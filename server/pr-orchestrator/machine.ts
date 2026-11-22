import { payloadOf } from "./projection.ts";
import { ciStatus, readiness } from "./readiness.ts";
import type { LedgerEntry, PrRecord, PrState, StepContext, TriggerName } from "./types.ts";

export const TRANSITIONS: Readonly<Record<PrState, readonly PrState[]>> = {
  open: ["ci_running", "ci_failed", "fixing", "reviewing", "needs_decision", "ready", "merged", "closed"],
  ci_running: ["open", "ci_failed", "fixing", "reviewing", "needs_decision", "ready", "merged", "closed"],
  ci_failed: ["open", "ci_running", "fixing", "reviewing", "needs_decision", "ready", "merged", "closed"],
  fixing: ["open", "ci_running", "ci_failed", "reviewing", "needs_decision", "ready", "merged", "closed"],
  reviewing: ["open", "ci_running", "ci_failed", "fixing", "needs_decision", "ready", "merged", "closed"],
  needs_decision: ["open", "ci_running", "ci_failed", "fixing", "reviewing", "ready", "merged", "closed"],
  ready: ["merging", "open", "ci_running", "ci_failed", "fixing", "reviewing", "needs_decision", "merged", "closed"],
  merging: ["merged", "open", "ready", "ci_running", "ci_failed", "fixing", "reviewing", "needs_decision", "closed"],
  merged: [],
  closed: ["open", "ci_running", "ci_failed", "fixing", "reviewing", "needs_decision", "ready"],
};

export function isLegal(from: PrState | null, to: PrState): boolean {
  return from === null ? to !== "merging" : TRANSITIONS[from].includes(to);
}

function isReopen(entry: LedgerEntry): boolean {
  return entry.type === "event.received" && entry.event.type === "pr.opened" && payloadOf(entry.event, "pr.opened").reopened === true;
}

export function deriveState(record: PrRecord, trigger: { name: TriggerName; entry: LedgerEntry }, ctx: StepContext): PrState {
  const { name, entry } = trigger;
  if (name === "pr.merged" || record.state === "merged") return "merged";
  if ((name === "pr.closed" || record.state === "closed") && !isReopen(entry)) return "closed";

  if (entry.type === "command.issued" && entry.command === "Merge") return "merging";
  if (record.state === "merging") {
    const mergeFailed = entry.type === "command.finished" && entry.command === "Merge" && entry.result.outcome !== "succeeded";
    if (!mergeFailed) return "merging";
  }

  if (record.draft || record.headSha === null) return "open";
  if (record.pendingDecision !== null) return "needs_decision";
  const ci = ciStatus(record, ctx);
  if (ci.failing.length > 0 || record.conflict) return Object.keys(record.activeRuns).length > 0 ? "fixing" : "ci_failed";
  if (!ci.settled) return "ci_running";
  return readiness(record, ctx).ready ? "ready" : "reviewing";
}
