import { describe, expect, it } from "vitest";
import { fold, foldAll } from "./projection.ts";
import { ciStatus, isExcused, readiness, unitsOf } from "./readiness.ts";
import { ctxFor, ev, row, SHA_A, SHA_B } from "./testing/builders.ts";
import type { LedgerEntry, OmbEvent, PrRecord } from "./types.ts";

type Item = LedgerEntry | OmbEvent;

function record(...items: Item[]): PrRecord {
  const folded = foldAll(items.map((item, index) => row(item, index + 1)));
  if (!folded) throw new Error("no record");
  return folded;
}
function refreshed(headSha: string, patch: { mergeable?: boolean | null; baseFailing?: string[]; requiredChecks?: string[] | null } = {}): LedgerEntry {
  const forge = { headSha, mergeable: patch.mergeable === undefined ? true : patch.mergeable, blockers: [], requiredChecks: patch.requiredChecks ?? null, baseFailing: patch.baseFailing ?? [], failedJobs: [] };
  return { type: "command.finished", commandId: "rf", command: "RefreshDetails", payload: { type: "RefreshDetails", headSha }, result: { outcome: "succeeded", detail: { forge } } };
}

const READY = [ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.reviewFinished({ head: SHA_A }), refreshed(SHA_A)];

describe("readiness", () => {
  it("is ready when every item holds", () => {
    expect(readiness(record(...READY), ctxFor())).toEqual({ ready: true, gaps: [], onlyForgeMissing: false });
  });

  it("excuses a failed job that also fails on the base head", () => {
    const failed = ev.ciFinished({ head: SHA_A, status: "failed", failedJobs: ["unit"] });
    const withBase = record(ev.opened({ head: SHA_A }), failed, ev.reviewFinished({ head: SHA_A }), refreshed(SHA_A, { baseFailing: ["unit"] }));
    const [check] = Object.values(withBase.checks);
    expect(unitsOf(check)).toEqual(["unit"]);
    expect(isExcused("unit", withBase, ctxFor())).toBe(true);
    expect(ciStatus(withBase, ctxFor()).failing).toEqual([]);
    expect(readiness(withBase, ctxFor()).ready).toBe(true);
    expect(readiness(withBase, ctxFor({ readiness: { compareBase: false } })).gaps).toEqual(["checks_not_passed"]);
    const otherJob = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed", failedJobs: ["unit", "lint"] }), refreshed(SHA_A, { baseFailing: ["unit"] }));
    expect(ciStatus(otherJob, ctxFor()).failing).toHaveLength(1);
    const noJobs = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed" }), refreshed(SHA_A, { baseFailing: ["github-actions/ci"] }));
    expect(unitsOf(Object.values(noJobs.checks)[0])).toEqual(["github-actions/ci"]);
    expect(ciStatus(noJobs, ctxFor()).failing).toEqual([]);
  });

  it("does not excuse a base failure that was read for another head", () => {
    const stale = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed", failedJobs: ["unit"] }), refreshed(SHA_A, { baseFailing: ["unit"] }), ev.pushed({ after: SHA_B }), ev.ciFinished({ head: SHA_B, status: "failed", failedJobs: ["unit"] }));
    expect(stale.forge).toBeNull();
    expect(ciStatus(stale, ctxFor()).failing).toHaveLength(1);
  });

  it("is not ready when the review covered an older head", () => {
    const pushed = record(...READY, ev.pushed({ after: SHA_B }), ev.ciFinished({ head: SHA_B }), refreshed(SHA_B));
    expect(readiness(pushed, ctxFor())).toMatchObject({ ready: false, gaps: ["review_not_passed"] });
    expect(readiness(pushed, ctxFor({ readiness: { requireReviewedHead: false } })).ready).toBe(true);
  });

  it("is not ready when the review failed, needs the person, or a decision is pending", () => {
    for (const status of ["failed", "needs-person"] as const) {
      const r = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.reviewFinished({ head: SHA_A, status }), refreshed(SHA_A));
      expect(readiness(r, ctxFor()).gaps).toEqual(["review_not_passed"]);
    }
    const pending = fold(record(...READY), row({ type: "command.finished", commandId: "a", command: "AskPerson", payload: { type: "AskPerson", kind: "decision", decisionId: "d", gaps: [], gated: null }, result: { outcome: "succeeded" } }, 99));
    expect(readiness(pending, ctxFor()).gaps).toEqual(["review_not_passed"]);
  });

  it("reports a draft, an unknown head, a conflict and failing CI as gaps in a fixed order", () => {
    const draft = record(ev.opened({ head: SHA_A, draft: true }), ev.ciFinished({ head: SHA_A, status: "failed" }), ev.conflict({ head: SHA_A }));
    expect(readiness(draft, ctxFor()).gaps).toEqual(["draft", "checks_not_passed", "conflict", "review_not_passed", "forge_stale", "not_mergeable"]);
    const noHead = record(ev.opened({ head: null }));
    expect(readiness(noHead, ctxFor()).gaps).toContain("head_unknown");
  });

  it("is not ready with stale forge facts and reports only the forge as missing", () => {
    const base = [ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.reviewFinished({ head: SHA_A })];
    expect(readiness(record(...base), ctxFor())).toEqual({ ready: false, gaps: ["forge_stale", "not_mergeable"], onlyForgeMissing: true });
    const stale = record(...base, refreshed(SHA_B));
    expect(readiness(stale, ctxFor())).toMatchObject({ ready: false, onlyForgeMissing: true });
    expect(readiness(record(...base), ctxFor({ readiness: { requireMergeable: false } }))).toEqual({ ready: false, gaps: ["forge_stale"], onlyForgeMissing: true });
    expect(readiness(record(...base, ev.conflict({ head: SHA_A })), ctxFor()).onlyForgeMissing).toBe(false);
  });

  it("is not ready when the forge says not mergeable, and does not count that as only forge missing", () => {
    const refused = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.reviewFinished({ head: SHA_A }), refreshed(SHA_A, { mergeable: false }));
    expect(readiness(refused, ctxFor())).toEqual({ ready: false, gaps: ["not_mergeable"], onlyForgeMissing: false });
    const unknown = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.reviewFinished({ head: SHA_A }), refreshed(SHA_A, { mergeable: null }));
    expect(readiness(unknown, ctxFor())).toMatchObject({ gaps: ["not_mergeable"], onlyForgeMissing: false });
  });

  it("waits for every configured required check to have a result", () => {
    const ctx = ctxFor({ readiness: { requiredChecks: ["github-actions/ci", "other-ci/**"] } });
    const one = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }));
    expect(ciStatus(one, ctx)).toMatchObject({ settled: false, required: ["github-actions/ci", "other-ci/**"] });
    const both = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.ciFinished({ head: SHA_A, source: "other-ci", name: "deploy/lint" }));
    expect(ciStatus(both, ctx).settled).toBe(true);
  });

  it("does not settle a wildcard required check on an early job result", () => {
    const ctx = ctxFor({ readiness: { requiredChecks: ["github-actions/*"] } });
    const job = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, scope: "job", name: "build" }));
    expect(ciStatus(job, ctx).settled).toBe(false);
    expect(ciStatus(job, ctxFor({ readiness: { requiredChecks: ["github-actions/job:build"] } })).settled).toBe(true);
    const workflow = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }));
    expect(ciStatus(workflow, ctx).settled).toBe(true);
  });

  it("asks for no review when requireReview is off, even with requireReviewedHead on", () => {
    const ctx = ctxFor({ readiness: { requireReview: false } });
    const unreviewed = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), refreshed(SHA_A));
    expect(readiness(unreviewed, ctx).gaps).not.toContain("review_not_passed");
    expect(readiness(unreviewed, ctxFor()).gaps).toContain("review_not_passed");
  });

  it("uses the required checks of a fresh forge when none are configured", () => {
    const withForge = (head: string, checks: string[]) => record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), refreshed(head, { requiredChecks: checks }));
    expect(ciStatus(withForge(SHA_A, ["github-actions/ci", "github-actions/lint"]), ctxFor())).toMatchObject({ settled: false, required: ["github-actions/ci", "github-actions/lint"] });
    expect(ciStatus(withForge(SHA_A, ["github-actions/ci"]), ctxFor()).settled).toBe(true);
    expect(ciStatus(withForge(SHA_A, []), ctxFor()).settled).toBe(true);
    expect(ciStatus(withForge(SHA_B, ["github-actions/lint"]), ctxFor())).toMatchObject({ settled: true, required: "observed" });
  });

  it("does not count job failures as a CI result, and a PR with no result is not settled", () => {
    expect(ciStatus(record(ev.opened({ head: SHA_A })), ctxFor())).toEqual({ settled: false, failing: [], optionalFailing: [], required: "observed" });
    const onlyJob = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, scope: "job", name: "unit", status: "failed" }));
    expect(ciStatus(onlyJob, ctxFor())).toMatchObject({ settled: false });
    expect(ciStatus(onlyJob, ctxFor()).failing).toHaveLength(1);
    const cancelled = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "cancelled" }));
    expect(ciStatus(cancelled, ctxFor()).failing).toHaveLength(1);
    const skipped = record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "skipped" }));
    expect(ciStatus(skipped, ctxFor())).toMatchObject({ settled: true, failing: [] });
  });

  it("does not block the merge on a failing check outside the configured required checks", () => {
    const ctx = ctxFor({ readiness: { requiredChecks: ["github-actions/ci"] } });
    const r = record(...READY, ev.ciFinished({ head: SHA_A, name: "lint", status: "failed" }));
    const status = ciStatus(r, ctx);
    expect(status.failing).toEqual([]);
    expect(status.optionalFailing.map(c => c.key)).toEqual(["github-actions/lint"]);
    expect(readiness(r, ctx).ready).toBe(true);
    const required = record(...READY, ev.ciFinished({ head: SHA_A, status: "failed" }));
    expect(ciStatus(required, ctx).failing).toHaveLength(1);
    expect(readiness(required, ctx).gaps).toEqual(["checks_not_passed"]);
  });

  it("does not block on a check outside fresh forge required checks, and blocks on any failing check in observed mode", () => {
    const base = [ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.ciFinished({ head: SHA_A, name: "lint", status: "failed" }), ev.reviewFinished({ head: SHA_A })];
    const withForge = record(...base, refreshed(SHA_A, { requiredChecks: ["github-actions/ci"] }));
    expect(ciStatus(withForge, ctxFor())).toMatchObject({ settled: true, failing: [], required: ["github-actions/ci"] });
    expect(ciStatus(withForge, ctxFor()).optionalFailing).toHaveLength(1);
    expect(readiness(withForge, ctxFor()).ready).toBe(true);
    const observed = record(...base, refreshed(SHA_A));
    expect(ciStatus(observed, ctxFor())).toMatchObject({ required: "observed", optionalFailing: [] });
    expect(ciStatus(observed, ctxFor()).failing).toHaveLength(1);
    expect(readiness(observed, ctxFor()).gaps).toEqual(["checks_not_passed"]);
  });
});
