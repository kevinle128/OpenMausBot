import { describe, expect, it } from "vitest";
import { factsOf } from "./facts.ts";
import { foldAll, triggerOf } from "./projection.ts";
import { ctxFor, ev, row, SHA_A, SHA_B } from "./testing/builders.ts";
import type { CommandPayload, LedgerEntry, OmbEvent, PrRecord } from "./types.ts";
import { FACT_NAMES } from "./types.ts";

type Item = LedgerEntry | OmbEvent;

function facts(items: Item[], ctx = ctxFor()) {
  const rows = items.map((item, index) => row(item, index + 1));
  const record = foldAll(rows) as PrRecord;
  const entry = rows[rows.length - 1].entry;
  return factsOf({ record, previousState: "ci_running", trigger: { name: triggerOf(entry) as string, entry }, ctx });
}

const WORKFLOW: CommandPayload = { type: "RunWorkflow", guard: "workflow:ci-fix", workflow: "ci-fix", connection: null, headSha: SHA_A, message: "fix", vars: {}, untrusted: {} };

describe("factsOf", () => {
  it("gives a value for every fact name", () => {
    const all = facts([ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed" })]);
    expect(Object.keys(all).sort()).toEqual([...FACT_NAMES].sort());
    for (const value of Object.values(all)) expect(value).not.toBeUndefined();
    expect(all).toMatchObject({
      previousState: "ci_running", draft: false, conflict: false, "owner.known": false, pendingDecision: null, "run.activeCount": 0,
      "trigger.isHead": true, "trigger.ci.status": "failed", "trigger.review.status": null, "ci.failingCount": 1,
      "review.staleForHead": false, "readiness.ready": false, "readiness.onlyForgeMissing": false,
      "event.connector": "github-event", "event.type": "pr.ci.finished", "event.subject.kind": "pr",
      "event.branch": "feature", "event.baseRef": "main", "event.author": "dev",
      "event.check.source": "github-actions", "event.check.name": "ci", "merge.quietNow": false, "merge.minutesToWindow": 0,
    });
  });

  it("reads the head test, the review status and a stale review", () => {
    expect(facts([ev.opened({ head: SHA_B }), ev.ciFinished({ head: SHA_A })])["trigger.isHead"]).toBe(false);
    expect(facts([ev.opened({ head: SHA_A }), ev.ciFinished({ head: null })])["trigger.isHead"]).toBe(false);
    expect(facts([ev.opened({ head: SHA_A }), ev.comment({ head: SHA_B })])["trigger.isHead"]).toBe(true);
    const stale = facts([ev.opened({ head: SHA_A }), ev.reviewFinished({ head: SHA_A, status: "needs-person", reviewedSha: SHA_B })]);
    expect(stale).toMatchObject({ "trigger.review.status": "needs-person", "trigger.isHead": true, "review.staleForHead": true, "event.check.source": null });
  });

  it("counts the active runs and reads the run target and outcome of a run finished trigger", () => {
    const running: Item[] = [ev.opened(), { type: "command.issued", commandId: "c1", command: "RunWorkflow", routineId: "r", payload: WORKFLOW }];
    expect(facts(running)).toMatchObject({ "run.activeCount": 1, "trigger.command.type": "RunWorkflow", "trigger.command.outcome": null });
    const done = facts([...running, { type: "run.finished", target: "workflow:ci-fix", runRef: "r1", outcome: "failed" }]);
    expect(done).toMatchObject({ "run.activeCount": 0, "trigger.run.target": "workflow:ci-fix", "trigger.run.outcome": "failed", "event.type": null });
  });

  it("reads the type, outcome and reason of a finished command", () => {
    const base: Item[] = [ev.opened()];
    const skipped = facts([...base, { type: "command.finished", commandId: "c1", command: "RunWorkflow", payload: WORKFLOW, result: { outcome: "skipped", reason: "not installed" } }]);
    expect(skipped).toMatchObject({ "trigger.command.type": "RunWorkflow", "trigger.command.outcome": "skipped", "trigger.command.reason": "not installed" });
    const failed = facts([...base, { type: "command.finished", commandId: "c1", command: "RunWorkflow", payload: WORKFLOW, result: { outcome: "failed", reason: "boom", retryable: false } }]);
    expect(failed).toMatchObject({ "trigger.command.outcome": "failed", "trigger.command.reason": "boom" });
    const timer = facts([...base, { type: "timer.fired", timerId: "t", kind: "merge.window" }]);
    expect(timer["trigger.timer.kind"]).toBe("merge.window");
  });

  it("gives only the event facts when there is no PR record", () => {
    const entry: LedgerEntry = { type: "event.received", event: { ...ev.opened(), type: "chat.message.posted", subject: { kind: "thread", id: "t1" } }, receivedSeq: 1 };
    const result = factsOf({ record: null, previousState: null, trigger: { name: "chat.message.posted", entry }, ctx: ctxFor() });
    expect(Object.keys(result).sort()).toEqual([...FACT_NAMES].sort());
    expect(result).toMatchObject({ "event.connector": "github-event", "event.type": "chat.message.posted", "event.subject.kind": "thread", "event.branch": null, state: null, "readiness.ready": null });
  });

  it("reads quiet hours across midnight in the configured time zone", () => {
    const quietHours = { start: "22:00", end: "07:00", timeZone: "Asia/Saigon" };
    const at = (hour: number, minute: number, day = 22) => facts([ev.opened()], ctxFor({ merge: { quietHours } }, Date.UTC(2026, 10, day, hour - 7, minute)));
    expect(at(23, 30)).toMatchObject({ "merge.quietNow": true, "merge.minutesToWindow": 450 });
    expect(at(6, 59, 23)).toMatchObject({ "merge.quietNow": true, "merge.minutesToWindow": 1 });
    expect(at(7, 0, 23)).toMatchObject({ "merge.quietNow": false, "merge.minutesToWindow": 0 });
    expect(at(12, 0)).toMatchObject({ "merge.quietNow": false, "merge.minutesToWindow": 0 });
    expect(at(22, 0)).toMatchObject({ "merge.quietNow": true, "merge.minutesToWindow": 540 });
    expect(at(0, 30, 23)).toMatchObject({ "merge.quietNow": true, "merge.minutesToWindow": 390 });
  });

  it("counts elapsed minutes to the window across a DST change", () => {
    const quietHours = { start: "22:00", end: "07:00", timeZone: "America/New_York" };
    const at = (utc: number) => facts([ev.opened()], ctxFor({ merge: { quietHours } }, utc));
    // 22:00 EDT on 2026-10-31; clocks go back at 02:00, so 07:00 EST is ten hours later.
    expect(at(Date.UTC(2026, 10, 1, 2, 0))).toMatchObject({ "merge.quietNow": true, "merge.minutesToWindow": 600 });
    // 22:00 EST on 2026-03-07; clocks go forward at 02:00, so 07:00 EDT is eight hours later.
    expect(at(Date.UTC(2026, 2, 8, 3, 0))).toMatchObject({ "merge.quietNow": true, "merge.minutesToWindow": 480 });
  });

  it("reads a quiet window inside one day and no window at all", () => {
    const quietHours = { start: "09:00", end: "17:30", timeZone: "UTC" };
    const at = (hour: number, minute: number) => facts([ev.opened()], ctxFor({ merge: { quietHours } }, Date.UTC(2026, 10, 22, hour, minute)));
    expect(at(9, 0)).toMatchObject({ "merge.quietNow": true, "merge.minutesToWindow": 510 });
    expect(at(17, 30)).toMatchObject({ "merge.quietNow": false });
    expect(at(8, 59)).toMatchObject({ "merge.quietNow": false });
    expect(facts([ev.opened()], ctxFor({ merge: { quietHours: null } }))).toMatchObject({ "merge.quietNow": false, "merge.minutesToWindow": 0 });
  });
});
