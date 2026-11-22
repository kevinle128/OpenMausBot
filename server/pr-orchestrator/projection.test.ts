import { describe, expect, it } from "vitest";
import { emptyRecord, fold, foldAll, triggerOf } from "./projection.ts";
import { ev, row, SHA_A, SHA_B } from "./testing/builders.ts";
import type { CommandPayload, ForgeBlocker, LedgerEntry, LedgerRow, Owner, PrRecord } from "./types.ts";

const WORKFLOW: Extract<CommandPayload, { type: "RunWorkflow" }> = {
  type: "RunWorkflow", guard: "workflow:ci-fix", workflow: "ci-fix", connection: null, headSha: SHA_A, message: "fix", vars: {}, untrusted: {},
};
const OWNER: Owner = {
  runtime: "paseo", hostId: "h", agentId: "a1", workspaceId: null, projectId: null, harness: null, model: null, boundBy: "claim", boundAt: 1,
};

type Item = LedgerEntry | ReturnType<typeof ev.opened>;

function rows(...entries: Item[]): LedgerRow[] {
  return entries.map((entry, index) => row(entry, index + 1));
}
function fixed(...entries: Item[]): PrRecord {
  const record = foldAll(rows(...entries));
  if (!record) throw new Error("no record");
  return record;
}
const issued = (commandId: string, payload: CommandPayload = WORKFLOW): LedgerEntry => ({ type: "command.issued", commandId, command: payload.type, routineId: "r", payload });
const finished = (commandId: string, result: Extract<LedgerEntry, { type: "command.finished" }>["result"], payload: CommandPayload = WORKFLOW): LedgerEntry =>
  ({ type: "command.finished", commandId, command: payload.type, payload, result });

describe("fold", () => {
  it("creates a record from the first event of a PR it never saw", () => {
    const record = fixed(ev.ciFinished({ head: SHA_A, status: "failed", branch: "fix-1", author: "ann" }));
    expect(record).toMatchObject({ key: "github:acme/widgets#1", provider: "github", repo: "acme/widgets", number: 1, headSha: SHA_A, branch: "fix-1", author: "ann", lastSeq: 1 });
    expect(Object.keys(record.checks)).toEqual(["github-actions/ci"]);
  });

  it("refuses to fold an event whose subject is not a PR", () => {
    const event = { ...ev.opened(), subject: { kind: "thread", id: "t1" } };
    expect(() => fold(null, row(event, 1))).toThrow("not a PR event");
    expect(() => fold(emptyRecord({ provider: "github", repo: "acme/widgets", number: 1, url: null }, 0), row(event, 1))).toThrow("not a PR event");
    expect(() => fold(null, row({ type: "person.answered", decisionId: "d", answer: "a" }, 1))).toThrow("ledger row for an unknown PR");
  });

  it("creates a record from a binding that arrives before the opened event", () => {
    const record = fixed({ type: "owner.bound", owner: OWNER, pr: { provider: "github", repo: "acme/widgets", number: 1, url: "https://example.test/pr/1" } });
    expect(record).toMatchObject({ owner: OWNER, headSha: null, url: "https://example.test/pr/1", state: "open" });
    const opened = fold(record, row(ev.opened({ head: SHA_A, title: "T" }), 2));
    expect(opened).toMatchObject({ owner: OWNER, headSha: SHA_A, title: "T" });
  });

  it("learns the head and url from a CI event when a binding opened the record", () => {
    const bound = fixed({ type: "owner.bound", owner: OWNER, pr: { provider: "github", repo: "acme/widgets", number: 1, url: null } });
    const ci = fold(bound, row(ev.ciFinished({ head: SHA_A }), 2));
    expect(ci).toMatchObject({ headSha: SHA_A, url: "https://example.test/acme/widgets/pull/1" });
    expect(Object.keys(ci.checks)).toEqual(["github-actions/ci"]);
  });

  it("keeps a review of the head when a late review of an older commit arrives", () => {
    const reviewed = fixed(ev.opened({ head: SHA_B }), ev.reviewFinished({ head: SHA_B, reviewedSha: SHA_B }));
    const late = fold(reviewed, row(ev.reviewFinished({ head: SHA_B, reviewedSha: SHA_A, status: "failed" }), 3));
    expect(late.review).toMatchObject({ reviewedSha: SHA_B, status: "success" });
  });

  it("clears head facts when a push moves the head and keeps the active runs", () => {
    const forge = { headSha: SHA_A, mergeable: true, blockers: [], requiredChecks: null, baseFailing: [], failedJobs: [] };
    const refresh = { type: "RefreshDetails", headSha: SHA_A } as const;
    const record = fixed(
      ev.opened({ head: SHA_A }),
      ev.ciFinished({ head: SHA_A, status: "failed" }),
      ev.conflict({ head: SHA_A }),
      finished("d", { outcome: "succeeded", detail: { forge } }, refresh),
      issued("c1"),
      ev.pushed({ after: SHA_B }),
    );
    expect(record).toMatchObject({ headSha: SHA_B, checks: {}, forge: null, conflict: false });
    expect(record.headSetAt).toBe(record.updatedAt);
    expect(Object.keys(record.activeRuns)).toEqual(["workflow:ci-fix"]);
  });

  it("clears the forge facts on a reopen", () => {
    const forge = { headSha: SHA_A, mergeable: true, blockers: [], requiredChecks: null, baseFailing: [], failedJobs: [] };
    const refresh = { type: "RefreshDetails", headSha: SHA_A } as const;
    const before = [ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.reviewFinished({ head: SHA_A }), finished("d", { outcome: "succeeded", detail: { forge } }, refresh), ev.closed()];
    expect(fixed(...before).forge).not.toBeNull();
    const reopened = fixed(...before, ev.opened({ head: SHA_A, reopened: true }));
    expect(reopened.forge).toBeNull();
    expect(Object.keys(reopened.checks)).toHaveLength(1);
    expect(reopened.review?.status).toBe("success");
    expect(fixed(...before, ev.opened({ head: SHA_A })).forge).not.toBeNull();
  });

  it("records a CI result for an old head in history only", () => {
    const record = fixed(ev.opened({ head: SHA_B }), ev.ciFinished({ head: SHA_A, status: "failed" }), ev.conflict({ head: SHA_A }), ev.ciFinished({ head: null, status: "failed" }));
    expect(record.checks).toEqual({});
    expect(record.conflict).toBe(false);
    expect(record.lastSeq).toBe(4);
  });

  it("marks a workflow run active when it is issued and keeps it while it runs", () => {
    const base = [ev.opened()];
    expect(fixed(...base, issued("c1")).activeRuns["workflow:ci-fix"]).toMatchObject({ commandId: "c1", status: "starting", runRef: null });
    const gated = fixed(...base, { type: "command.gated", commandId: "c1", command: "RunWorkflow", routineId: "r", payload: WORKFLOW, decisionId: "k#approve" });
    expect(gated.activeRuns["workflow:ci-fix"].status).toBe("awaiting_approval");
    const started = [...base, issued("c1"), finished("c1", { outcome: "succeeded", detail: { runRef: "run-9" } })];
    expect(fixed(...started).activeRuns["workflow:ci-fix"]).toMatchObject({ commandId: "c1", status: "running", runRef: "run-9" });
    expect(fixed(...started, ev.pushed()).activeRuns["workflow:ci-fix"].runRef).toBe("run-9");
  });

  it("clears an active run when the start was skipped or failed, and when the run finished", () => {
    const base = [ev.opened(), issued("c1")];
    expect(fixed(...base, finished("c1", { outcome: "skipped", reason: "not installed" })).activeRuns).toEqual({});
    expect(fixed(...base, finished("c1", { outcome: "failed", reason: "boom", retryable: false })).activeRuns).toEqual({});
    const running = [...base, finished("c1", { outcome: "succeeded", detail: { runRef: "run-9" } })];
    expect(fixed(...running, { type: "run.finished", target: "workflow:ci-fix", runRef: "run-9", outcome: "completed" }).activeRuns).toEqual({});
    expect(fixed(...base, { type: "run.finished", target: "workflow:ci-fix", runRef: "run-9", outcome: "failed" }).activeRuns).toEqual({});
  });

  it("ignores a run finished event for another run of the same target", () => {
    const record = fixed(ev.opened(), issued("c1"), finished("c1", { outcome: "succeeded", detail: { runRef: "run-9" } }), { type: "run.finished", target: "workflow:ci-fix", runRef: "run-1", outcome: "completed" });
    expect(Object.keys(record.activeRuns)).toEqual(["workflow:ci-fix"]);
  });

  it("clears job failures of a source when its workflow passes on the same head", () => {
    const failed = fixed(
      ev.opened(),
      ev.ciFinished({ scope: "job", name: "unit", status: "failed" }),
      ev.ciFinished({ scope: "job", name: "lint", source: "other-ci", status: "failed" }),
    );
    expect(Object.keys(failed.checks)).toEqual(["github-actions/job:unit", "other-ci/job:lint"]);
    const passed = fold(failed, row(ev.ciFinished({ scope: "workflow", name: "ci", status: "passed" }), 9));
    expect(Object.keys(passed.checks).sort()).toEqual(["github-actions/ci", "other-ci/job:lint"]);
    const suite = fold(failed, row(ev.ciFinished({ scope: "suite", name: "suite", status: "passed", source: "other-ci" }), 9));
    expect(Object.keys(suite.checks).sort()).toEqual(["github-actions/job:unit", "other-ci/suite"]);
    const stillFailed = fold(failed, row(ev.ciFinished({ scope: "workflow", name: "ci", status: "failed" }), 9));
    expect(Object.keys(stillFailed.checks)).toContain("github-actions/job:unit");
  });

  it("keeps a commit status keyed by its context so a later pass replaces a failure", () => {
    const record = fixed(ev.opened(), ev.ciFinished({ scope: "status", name: "ci/lint", status: "failed" }), ev.ciFinished({ scope: "status", name: "ci/lint", status: "passed" }));
    expect(Object.values(record.checks).map(c => [c.key, c.status])).toEqual([["github-actions/ci/lint", "passed"]]);
  });

  it("sets and clears the pending decision by decision id", () => {
    const ask: CommandPayload = { type: "AskPerson", kind: "decision", decisionId: "d1", gaps: [], gated: null };
    const asked = fixed(ev.opened(), issued("c2", ask), finished("c2", { outcome: "succeeded", detail: { cardId: "card" } }, ask));
    expect(asked.pendingDecision).toMatchObject({ decisionId: "d1", kind: "decision", commandId: "c2" });
    const other = fold(asked, row({ type: "person.answered", decisionId: "d0", answer: "x" }, 9));
    expect(other.pendingDecision?.decisionId).toBe("d1");
    const answered = fold(asked, row({ type: "person.answered", decisionId: "d1", answer: "approve" }, 9));
    expect(answered.pendingDecision).toBeNull();
    expect(answered.lastAnswer).toMatchObject({ decisionId: "d1", answer: "approve" });
    const skipped = fixed(ev.opened(), issued("c2", ask), finished("c2", { outcome: "skipped", reason: "not installed" }, ask));
    expect(skipped.pendingDecision).toBeNull();
  });

  it("takes forge facts only from a successful details refresh and reads the conflict from them", () => {
    const refresh = { type: "RefreshDetails", headSha: SHA_A } as const;
    const forge = (headSha: string, blockers: ForgeBlocker[]) => ({ headSha, mergeable: false, blockers, requiredChecks: null, baseFailing: [], failedJobs: [] });
    const opened = fixed(ev.opened({ head: SHA_A }));
    expect(fold(opened, row(finished("c", { outcome: "skipped", reason: "x" }, refresh), 5)).forge).toBeNull();
    const withConflict = fold(opened, row(finished("c", { outcome: "succeeded", detail: { forge: forge(SHA_A, ["conflict"]) } }, refresh), 5));
    expect(withConflict.forge).toMatchObject({ headSha: SHA_A, at: withConflict.updatedAt });
    expect(withConflict.conflict).toBe(true);
    const cleared = fold(withConflict, row(finished("c", { outcome: "succeeded", detail: { forge: forge(SHA_A, []) } }, refresh), 6));
    expect(cleared.conflict).toBe(false);
    const stale = fold(withConflict, row(finished("c", { outcome: "succeeded", detail: { forge: forge(SHA_B, []) } }, refresh), 6));
    expect(stale.conflict).toBe(true);
    expect(stale.forge).toMatchObject({ headSha: SHA_A });
  });

  it("gives the same record when the same rows are folded twice", () => {
    const all = rows(ev.opened(), ev.ciFinished({ status: "failed" }), ev.pushed(), ev.reviewFinished(), { type: "state.changed", from: null, to: "ci_running", trigger: "pr.opened" });
    expect(foldAll(all)).toEqual(foldAll(all));
    expect(foldAll(all)).toMatchObject({ state: "ci_running", review: { status: "success" }, headSha: SHA_B });
    expect(foldAll([])).toBeNull();
  });

  it("never changes the record it was given", () => {
    const start = fixed(ev.opened(), ev.ciFinished({ status: "failed" }), issued("c1"));
    const frozen = structuredClone(start);
    const next = rows(
      ev.pushed(), ev.ciFinished(), ev.reviewFinished(), ev.conflict(),
      { type: "run.finished", target: "workflow:ci-fix", runRef: "r", outcome: "completed" },
      { type: "state.changed", from: "open", to: "ready", trigger: "x" },
    );
    for (const item of next) expect(fold(start, item)).not.toBe(start);
    expect(start).toEqual(frozen);
  });
});

describe("triggerOf", () => {
  it("names events and inputs and leaves decisions without a trigger", () => {
    expect(triggerOf({ type: "event.received", event: ev.ciFinished(), receivedSeq: 1 })).toBe("pr.ci.finished");
    expect(triggerOf({ type: "run.finished", target: "t", runRef: "r", outcome: "failed" })).toBe("run.finished");
    expect(triggerOf(issued("c1"))).toBe("command.issued");
    expect(triggerOf({ type: "state.changed", from: null, to: "open", trigger: "x" })).toBeNull();
    expect(triggerOf({ type: "command.gated", commandId: "c", command: "RunWorkflow", routineId: "r", payload: WORKFLOW, decisionId: "d" })).toBeNull();
    expect(triggerOf({ type: "routine.matched", routineId: "r", trigger: "x", triggerSeq: 1, actions: [] })).toBeNull();
  });
});
