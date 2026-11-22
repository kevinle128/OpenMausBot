import { describe, expect, it } from "vitest";
import { prStatusForBot } from "./bot-status.ts";
import { foldAll } from "./projection.ts";
import { ctxFor, ev, row, SHA_A, SHA_B, T0 } from "./testing/builders.ts";
import { FAKE_OWNER } from "./testing/fake-runtime.ts";
import type { LedgerEntry, OmbEvent, PrRecord } from "./types.ts";

type Item = LedgerEntry | OmbEvent;

function record(...items: Item[]): PrRecord {
  const folded = foldAll(items.map((item, index) => row(item, index + 1)));
  if (!folded) throw new Error("no record");
  return folded;
}

const at = T0;

describe("PR status for a bot", () => {
  it("a review of an older head shows onHead false", () => {
    const status = prStatusForBot(
      record(ev.opened({ head: SHA_A }), ev.reviewFinished({ head: SHA_A }), ev.pushed({ after: SHA_B })),
      ctxFor(), at,
    );
    expect(status.headSha).toBe(SHA_B);
    expect(status.review).toMatchObject({ reviewedSha: SHA_A, onHead: false, status: "success" });
    expect(status.asOf).toBe(new Date(at).toISOString());
  });

  it("a failed required check shows in failing and keeps settled false", () => {
    const status = prStatusForBot(
      record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed" })),
      ctxFor(), at,
    );
    expect(status.checks).toEqual([{ key: "github-actions/ci", status: "failed", url: "https://example.test/run/1" }]);
    expect(status.ci).toMatchObject({ settled: false, failing: ["github-actions/ci"], optionalFailing: [], required: "observed" });
  });

  it("with no forge facts, mergeable is null and the forge gaps are left out", () => {
    const status = prStatusForBot(
      record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.reviewFinished({ head: SHA_A })),
      ctxFor(), at,
    );
    expect(status.mergeable).toBeNull();
    expect(status.gaps).not.toContain("forge_stale");
    expect(status.gaps).not.toContain("not_mergeable");
    expect(status.conflict).toBe(false);
  });

  it("a fresh forge read that refuses the merge keeps not_mergeable in gaps", () => {
    const forge = { headSha: SHA_A, mergeable: false, blockers: [], requiredChecks: null, baseFailing: [], failedJobs: [] };
    const refreshed: LedgerEntry = { type: "command.finished", commandId: "rf", command: "RefreshDetails", payload: { type: "RefreshDetails", headSha: SHA_A }, result: { outcome: "succeeded", detail: { forge } } };
    const status = prStatusForBot(
      record(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A }), ev.reviewFinished({ head: SHA_A }), refreshed),
      ctxFor(), at,
    );
    expect(status.mergeable).toBe(false);
    expect(status.gaps).toEqual(["not_mergeable"]);
  });

  it("a PR with no owner shows owner null", () => {
    const status = prStatusForBot(record(ev.opened({ head: SHA_A })), ctxFor(), at);
    expect(status.owner).toBeNull();
  });

  it("a bound owner shows the runtime, the agent and the folder", () => {
    const status = prStatusForBot(record(
      { type: "owner.bound", owner: FAKE_OWNER, pr: { provider: "github", repo: "acme/widgets", number: 1, url: null } },
      ev.opened({ head: SHA_A }),
    ), ctxFor(), at);
    expect(status.owner).toEqual({ runtime: "fake", agentId: "agent-1", cwd: "/work/owner" });
  });
});
