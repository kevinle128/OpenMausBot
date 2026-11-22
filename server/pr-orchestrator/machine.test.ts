import { describe, expect, it } from "vitest";
import { deriveState, isLegal, TRANSITIONS } from "./machine.ts";
import { fold, triggerOf } from "./projection.ts";
import { ctxFor, ev, row, SHA_A, SHA_B } from "./testing/builders.ts";
import type { CommandPayload, LedgerEntry, OmbEvent, PrRecord, StepContext } from "./types.ts";
import { PR_STATES } from "./types.ts";

type Item = LedgerEntry | OmbEvent;

const WORKFLOW: CommandPayload = { type: "RunWorkflow", guard: "workflow:ci-fix", workflow: "ci-fix", connection: null, headSha: SHA_A, message: "fix", vars: {}, untrusted: {} };
const MERGE: CommandPayload = { type: "Merge", method: "squash", expectedHeadSha: SHA_A, deleteBranch: true };
const ASK: CommandPayload = { type: "AskPerson", kind: "decision", decisionId: "d1", gaps: [], gated: null };
const issued = (id: string, payload: CommandPayload): LedgerEntry => ({ type: "command.issued", commandId: id, command: payload.type, routineId: "r", payload });
const finished = (id: string, payload: CommandPayload, result: Extract<LedgerEntry, { type: "command.finished" }>["result"]): LedgerEntry =>
  ({ type: "command.finished", commandId: id, command: payload.type, payload, result });
const forge = (headSha: string) => ({ headSha, mergeable: true, blockers: [], requiredChecks: null, baseFailing: [], failedJobs: [] });
const refreshed = (headSha: string): LedgerEntry => finished("rf", { type: "RefreshDetails", headSha }, { outcome: "succeeded", detail: { forge: forge(headSha) } });

/** Folds each item, derives the state after it and records a change, as a step does. */
function play(items: Item[], ctx: StepContext = ctxFor()): PrRecord {
  let record: PrRecord | null = null;
  let seq = 0;
  for (const item of items) {
    const input = row(item, ++seq);
    record = fold(record, input);
    const name = triggerOf(input.entry);
    if (!name) continue;
    const to = deriveState(record, { name, entry: input.entry }, ctx);
    if (to !== record.state) record = fold(record, row({ type: "state.changed", from: record.state, to, trigger: name }, ++seq));
  }
  if (!record) throw new Error("no record");
  return record;
}

const GREEN = [ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "passed" })];
const READY = [...GREEN, ev.reviewFinished({ head: SHA_A }), refreshed(SHA_A)];

describe("transitions", () => {
  it("allows merging only from ready", () => {
    for (const state of PR_STATES) expect(isLegal(state, "merging")).toBe(state === "ready");
    expect(isLegal(null, "merging")).toBe(false);
    expect(isLegal(null, "ready")).toBe(true);
  });

  it("treats merged as final and lets a closed PR only reopen", () => {
    expect(TRANSITIONS.merged).toEqual([]);
    expect(TRANSITIONS.closed).toEqual(["open", "ci_running", "ci_failed", "fixing", "reviewing", "needs_decision", "ready"]);
    for (const state of PR_STATES) expect(isLegal("merged", state)).toBe(false);
    expect(isLegal("closed", "merging")).toBe(false);
    expect(isLegal("closed", "merged")).toBe(false);
  });
});

describe("deriveState", () => {
  it("derives ci_running for an opened PR with a head and no CI result", () => {
    expect(play([ev.opened({ head: SHA_A })]).state).toBe("ci_running");
    expect(play([ev.opened({ head: SHA_A, draft: true })]).state).toBe("open");
    expect(play([ev.opened({ head: null })]).state).toBe("open");
  });

  it("derives ci_failed, then fixing while a workflow run is active, then ci_failed again when it ends with CI still red", () => {
    const failed = [ev.opened(), ev.ciFinished({ status: "failed" })];
    expect(play(failed).state).toBe("ci_failed");
    expect(play([...failed, issued("c1", WORKFLOW)]).state).toBe("fixing");
    const running = [...failed, issued("c1", WORKFLOW), finished("c1", WORKFLOW, { outcome: "succeeded", detail: { runRef: "r1" } })];
    expect(play(running).state).toBe("fixing");
    expect(play([...running, { type: "run.finished", target: "workflow:ci-fix", runRef: "r1", outcome: "completed" }]).state).toBe("ci_failed");
    expect(play([...failed, issued("c1", WORKFLOW), finished("c1", WORKFLOW, { outcome: "skipped", reason: "not installed" })]).state).toBe("ci_failed");
  });

  it("derives reviewing when CI passed and the review of the head is missing", () => {
    expect(play(GREEN).state).toBe("reviewing");
    expect(play([...GREEN, ev.reviewFinished({ head: SHA_A, reviewedSha: SHA_B })]).state).toBe("reviewing");
    expect(play([...GREEN, ev.reviewFinished({ head: SHA_A }), ev.conflict({ head: SHA_A })]).state).toBe("ci_failed");
  });

  it("derives ready when every readiness item holds", () => {
    expect(play(READY).state).toBe("ready");
    expect(play([...READY, ev.pushed({ after: SHA_B })]).state).toBe("ci_running");
  });

  it("keeps merging until the merged event and leaves it when the merge did not happen", () => {
    const merging = [...READY, issued("m1", MERGE)];
    expect(play(merging).state).toBe("merging");
    expect(play([...merging, ev.comment()]).state).toBe("merging");
    expect(play([...merging, ev.pushed({ after: SHA_B })]).state).toBe("merging");
    const succeeded = [...merging, finished("m1", MERGE, { outcome: "succeeded", detail: { merged: true, sha: SHA_B } })];
    expect(play(succeeded).state).toBe("merging");
    expect(play([...succeeded, ev.merged()]).state).toBe("merged");
    expect(play([...merging, finished("m1", MERGE, { outcome: "skipped", reason: "not installed" })]).state).toBe("ready");
    expect(play([...merging, finished("m1", MERGE, { outcome: "failed", reason: "boom", retryable: false })]).state).toBe("ready");
    expect(play([...merging, ev.closed()]).state).toBe("closed");
    const draftThenSkipped = play([...merging, ev.opened({ head: SHA_A, draft: true }), finished("m1", MERGE, { outcome: "skipped", reason: "draft" })]);
    expect(draftThenSkipped.state).toBe("open");
    expect(isLegal("merging", "open")).toBe(true);
  });

  it("keeps a merged PR merged and a closed PR closed when late events arrive", () => {
    const merged = [...READY, ev.merged()];
    expect(play(merged).state).toBe("merged");
    expect(play([...merged, ev.pushed({ after: SHA_B }), ev.ciFinished({ status: "failed" }), ev.closed(), issued("c1", WORKFLOW)]).state).toBe("merged");
    const closed = [ev.opened(), ev.closed()];
    expect(play(closed).state).toBe("closed");
    expect(play([...closed, ev.pushed({ after: SHA_B }), ev.ciFinished({ head: SHA_B, status: "failed" }), ev.opened({ head: SHA_B })]).state).toBe("closed");
  });

  it("reopens a closed PR on a reopened event", () => {
    const closed = [ev.opened({ head: SHA_A }), ev.closed()];
    expect(play([...closed, ev.opened({ head: SHA_A, reopened: true })]).state).toBe("ci_running");
    expect(play([...closed, ev.opened({ head: SHA_A, reopened: true, draft: true })]).state).toBe("open");
  });

  it("reopens a closed PR at the same head straight to ready when its checks and review still hold", () => {
    const reopened = [...READY, ev.closed(), ev.opened({ head: SHA_A, reopened: true })];
    const record = play(reopened);
    expect(record).toMatchObject({ headSha: SHA_A, review: { status: "success" }, forge: null });
    expect(Object.keys(record.checks)).toHaveLength(1);
    expect(record.state).toBe("reviewing");
    expect(isLegal("closed", "ready")).toBe(true);
    expect(play([...reopened, refreshed(SHA_A)]).state).toBe("ready");
  });

  it("derives needs_decision while a decision is pending, even with green CI", () => {
    const asked = [...GREEN, issued("a1", ASK), finished("a1", ASK, { outcome: "succeeded", detail: { cardId: "card" } })];
    expect(play(asked).state).toBe("needs_decision");
    expect(play([...asked, { type: "person.answered", decisionId: "d1", answer: "approve" }]).state).toBe("reviewing");
  });
});
