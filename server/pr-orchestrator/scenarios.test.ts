/* oxlint-disable unicorn/no-thenable -- a routine's action list is named "then" in the config document */
import { afterEach, describe, expect, it } from "vitest";
import { renderMessage } from "./messages.ts";
import { DEFAULT_PR_KEY, ev, SHA_A, SHA_B } from "./testing/builders.ts";
import { FORGE_A, FORGE_B, makeHarness, type Harness } from "./testing/pm-harness.ts";
import type { CommandRecord } from "./types.ts";

const GUARD = "workflow:ci-fix";
const WITH_WORKFLOW = { enabled: true, workflows: { ciFix: { workflow: "ci-fix" } }, routines: { useDefaults: true } };

let h: Harness;
const start = (doc: Record<string, unknown> = WITH_WORKFLOW) => { h = makeHarness(doc); return h; };
afterEach(() => {
  expect(h.pm.verifyProjection()).toEqual([]);
  h.close();
});

const only = (type: Parameters<Harness["commands"]>[0]): CommandRecord => {
  const found = h.commands(type);
  expect(found).toHaveLength(1);
  return found[0];
};
const succeeded = (command: CommandRecord, detail?: { runRef: string } | { forge: typeof FORGE_B }) =>
  h.finish(command, detail ? { outcome: "succeeded", detail } : { outcome: "succeeded" });

function bringToReady(head: string = SHA_A, forge = FORGE_A) {
  h.send(ev.opened({ head }), ev.ciFinished({ head }), ev.reviewFinished({ head, reviewedSha: head }));
  succeeded(only("RefreshDetails"), { forge });
}

describe("a PR through the default routines", () => {
  it("takes a PR from a CI failure through a workflow run to a merge", () => {
    start();
    h.send(ev.opened({ head: SHA_A }));
    h.send(ev.ciFinished({ head: SHA_A, status: "failed", failedJobs: ["unit"] }));
    const run = only("RunWorkflow");
    expect(run.payload).toMatchObject({ guard: GUARD, workflow: "ci-fix", headSha: SHA_A, connection: null });
    expect(h.record().activeRuns[GUARD]).toMatchObject({ status: "starting" });
    succeeded(run, { runRef: "run-1" });
    expect(h.record().activeRuns[GUARD]).toMatchObject({ status: "running", runRef: "run-1" });

    h.send(ev.pushed({ head: SHA_B, after: SHA_B }));
    h.pm.runFinished(DEFAULT_PR_KEY, { target: GUARD, runRef: "run-1", outcome: "completed" });
    expect(h.record().activeRuns).toEqual({});
    h.send(ev.ciFinished({ head: SHA_B }), ev.reviewFinished({ head: SHA_B, reviewedSha: SHA_B }));
    succeeded(only("RefreshDetails"), { forge: FORGE_B });

    expect(h.states()).toEqual(["ci_running", "ci_failed", "fixing", "ci_running", "reviewing", "ready", "merging"]);
    expect(h.commands().map(c => c.type)).toEqual(["RunWorkflow", "RefreshDetails", "Merge"]);
    expect(only("Merge").payload).toMatchObject({ method: "squash", expectedHeadSha: SHA_B, deleteBranch: true });
  });

  it("records every command as skipped and never merges when nothing is installed", () => {
    start();
    const observed: string[] = [];
    const feed = (...events: Parameters<Harness["send"]>) => {
      h.send(...events);
      h.settleSkipped();
      observed.push(h.record().state);
    };
    feed(ev.opened({ head: SHA_A }));
    feed(ev.ciFinished({ head: SHA_A, status: "failed" }));
    feed(ev.pushed({ head: SHA_B, after: SHA_B }));
    feed(ev.ciFinished({ head: SHA_B }));
    feed(ev.reviewFinished({ head: SHA_B, reviewedSha: SHA_B }));

    expect(observed).toEqual(["ci_running", "ci_failed", "ci_running", "reviewing", "reviewing"]);
    expect(h.states()).toEqual(["ci_running", "ci_failed", "fixing", "ci_failed", "ci_running", "reviewing"]);
    expect(h.states()).not.toContain("merging");
    expect(h.commands("Merge")).toEqual([]);
    expect(h.commands().every(c => c.outcome === "skipped")).toBe(true);
    feed(ev.ciFinished({ head: SHA_B, status: "failed", name: "lint" }));
    expect(h.commands("RunWorkflow")).toHaveLength(2);
    expect(h.commands("RunWorkflow").every(c => c.outcome === "skipped")).toBe(true);
    expect(h.record().activeRuns).toEqual({});
    expect(h.record().pendingDecision).toBeNull();
  });

  it("ignores late CI results and pushes on a merged or closed PR", () => {
    let previous: Harness | null = null;
    for (const end of [ev.merged({ head: SHA_A }), ev.closed({ head: SHA_A })]) {
      if (previous) {
        expect(previous.pm.verifyProjection()).toEqual([]);
        previous.close();
      }
      previous = start();
      h.send(ev.opened({ head: SHA_A }), end);
      h.settleSkipped();
      const state = h.record().state;
      const commands = h.commands().length;
      const states = h.states();
      h.send(ev.ciFinished({ head: SHA_A, status: "failed" }), ev.pushed({ head: SHA_B, after: SHA_B }), ev.ciFinished({ head: SHA_B, status: "failed" }));
      expect(h.record().state).toBe(state);
      expect(h.commands()).toHaveLength(commands);
      expect(h.states()).toEqual(states);
      expect(h.entries("transition.refused")).toEqual([]);
    }
  });

  it("starts no second workflow run while one is active, but records the event", () => {
    start();
    h.send(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed", name: "unit" }));
    h.send(ev.ciFinished({ head: SHA_A, status: "failed", name: "lint" }));
    expect(h.commands("RunWorkflow")).toHaveLength(1);
    expect(h.entries("event.received").filter(e => e.event.type === "pr.ci.finished")).toHaveLength(2);
    const runs = h.entries("routine.matched").filter(entry => entry.routineId === "run-ci-fix-workflow");
    expect(runs.at(-1)?.actions).toEqual([
      expect.objectContaining({ action: "RunWorkflow", result: "skipped", reason: `a run of ${GUARD} is active` }),
    ]);
  });

  it("starts a new workflow run after the earlier run finished, completed or failed", () => {
    start();
    h.send(ev.opened({ head: SHA_A }));
    for (const [index, outcome] of (["completed", "failed"] as const).entries()) {
      h.send(ev.ciFinished({ head: SHA_A, status: "failed", name: `unit-${index}` }));
      const run = h.commands("RunWorkflow")[index];
      succeeded(run, { runRef: `run-${index}` });
      h.pm.runFinished(DEFAULT_PR_KEY, { target: GUARD, runRef: `run-${index}`, outcome });
    }
    h.send(ev.ciFinished({ head: SHA_A, status: "failed", name: "unit-last" }));
    expect(h.commands("RunWorkflow")).toHaveLength(3);
  });

  it("keeps the run active across a push and clears it on run finished", () => {
    start();
    h.send(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed" }));
    succeeded(only("RunWorkflow"), { runRef: "run-1" });
    h.send(ev.pushed({ head: SHA_B, after: SHA_B }));
    expect(h.record().activeRuns[GUARD]).toMatchObject({ status: "running" });
    h.pm.runFinished(DEFAULT_PR_KEY, { target: GUARD, runRef: "run-1", outcome: "failed" });
    expect(h.record().activeRuns).toEqual({});
  });

  it("does nothing when CI fails and no fix workflow is configured", () => {
    start({ enabled: true });
    h.send(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed" }));
    expect(h.commands()).toEqual([]);
    expect(h.record().state).toBe("ci_failed");
  });

  it("holds a gated workflow run as active until the person answers", () => {
    start({
      ...WITH_WORKFLOW,
      routines: { custom: [{
        id: "run-ci-fix-workflow", name: "Run the CI fix workflow when CI fails", active: true,
        when: { on: ["pr.ci.finished"], all: [{ fact: "trigger.ci.status", op: "eq", value: "failed" }] },
        then: [{ do: "RunWorkflow", askFirst: true, params: {
          workflow: { config: "workflows.ciFix.workflow" }, message: { config: "workflows.ciFix.message" }, connection: { config: "workflows.ciFix.connection" },
        } }],
        once: "per-trigger",
      }] },
    });
    h.send(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed", name: "unit" }));
    const held = only("RunWorkflow");
    expect(held.status).toBe("awaiting_approval");
    expect(h.record().activeRuns[GUARD]).toMatchObject({ status: "awaiting_approval", commandId: held.id });
    h.send(ev.ciFinished({ head: SHA_A, status: "failed", name: "lint" }));
    expect(h.commands("RunWorkflow")).toHaveLength(1);

    const card = only("AskPerson");
    succeeded(card);
    h.pm.answer(DEFAULT_PR_KEY, held.approvalId as string, "approve");
    expect(h.store.getCommand(held.id)).toMatchObject({ status: "pending" });
    expect(h.record().activeRuns[GUARD]).toMatchObject({ status: "starting" });
  });

  it("asks the person about a review decision and sends the answer to the owner", () => {
    start();
    h.send(ev.opened({ head: SHA_A }), ev.reviewFinished({ head: SHA_A, status: "needs-person", reviewedSha: SHA_A }));
    const ask = only("AskPerson");
    expect(ask.payload).toMatchObject({ kind: "decision", gated: null });
    succeeded(ask);
    expect(h.record()).toMatchObject({ state: "needs_decision", pendingDecision: { kind: "decision" } });

    const decisionId = (ask.payload as { decisionId: string }).decisionId;
    h.pm.answer(DEFAULT_PR_KEY, decisionId, "use option 2");
    expect(h.record().pendingDecision).toBeNull();
    expect(h.record().state).not.toBe("needs_decision");
    const tell = only("TellOwner");
    expect(tell.payload).toMatchObject({ template: "decisionAnswered", untrusted: { answer: "use option 2", question: "decision" } });
    const payload = tell.payload as { vars: Record<string, string>; untrusted: Record<string, string> };
    expect(renderMessage("{{answer}}", payload.vars, payload.untrusted)).toContain("use option 2");
  });

  it("tells the owner about a conflict on the head once, and the stub records it as skipped", () => {
    start();
    h.send(ev.opened({ head: SHA_A }), ev.conflict({ head: SHA_A }));
    h.send(ev.conflict({ head: SHA_A }));
    const tell = only("TellOwner");
    expect(tell.payload).toMatchObject({ template: "conflict", headSha: SHA_A });
    h.finish(tell, { outcome: "skipped", reason: "owner not found" });
    expect(h.store.getCommand(tell.id)).toMatchObject({ outcome: "skipped" });
    expect(h.commands("AskPerson")).toEqual([]);
  });

  it("waits for the end of quiet hours to merge", () => {
    start({ ...WITH_WORKFLOW, merge: { quietHours: { start: "22:00", end: "07:00", timeZone: "Asia/Saigon" } } });
    h.clock.set(Date.UTC(2026, 10, 22, 16, 0));
    bringToReady();
    expect(h.record().state).toBe("ready");
    expect(h.commands("Merge")).toEqual([]);
    const [timer] = h.store.armedTimers(DEFAULT_PR_KEY, "merge.window");
    expect(timer.dueAt).toBe(Date.UTC(2026, 10, 22, 16, 0) + 8 * 60 * 60_000);

    h.clock.set(timer.dueAt);
    h.pm.fireTimer(timer);
    expect(h.store.armedTimers(DEFAULT_PR_KEY)).toEqual([]);
    expect(only("Merge").payload).toMatchObject({ expectedHeadSha: SHA_A });
    expect(h.record().state).toBe("merging");
  });

  it("only notifies when auto-merge is off for the repo", () => {
    start({ ...WITH_WORKFLOW, overrides: [{ match: { repos: ["acme/*"] }, set: { merge: { auto: false } } }] });
    bringToReady();
    expect(h.record().state).toBe("ready");
    expect(h.commands("Merge")).toEqual([]);
    expect(only("Notify").payload).toEqual({ type: "Notify", kind: "ready_no_auto_merge" });
  });

  it("asks the person when a workflow run could not be started", () => {
    start();
    h.send(ev.opened({ head: SHA_A }), ev.ciFinished({ head: SHA_A, status: "failed" }));
    h.finish(only("RunWorkflow"), { outcome: "failed", reason: "no runtime", retryable: false });
    expect(h.record().activeRuns).toEqual({});
    const ask = only("AskPerson");
    expect(ask.payload).toMatchObject({ kind: "command_failed" });
    succeeded(ask);
    expect(h.record()).toMatchObject({ state: "needs_decision", pendingDecision: { kind: "command_failed" } });
  });

  it("notifies and tells the owner if found after the merge, and does nothing more when no owner is found", () => {
    start();
    h.send(ev.opened({ head: SHA_A }), ev.merged({ head: SHA_A }));
    expect(h.record().state).toBe("merged");
    const notify = only("Notify");
    const tell = only("TellOwner");
    expect(notify.payload).toEqual({ type: "Notify", kind: "merged" });
    expect(tell.payload).toMatchObject({ template: "merged", vars: { mergeSha: SHA_B } });
    succeeded(notify);
    h.finish(tell, { outcome: "skipped", reason: "owner not found" });
    expect(h.commands()).toHaveLength(2);
    expect(h.commands().every(c => c.status === "done")).toBe(true);
    expect(h.entries("transition.refused")).toEqual([]);
  });

  it("ignores CI results for an old head", () => {
    start();
    h.send(ev.opened({ head: SHA_A }), ev.pushed({ head: SHA_B, after: SHA_B }));
    const states = h.states();
    h.send(ev.ciFinished({ head: SHA_A, status: "failed" }));
    expect(h.commands()).toEqual([]);
    expect(h.states()).toEqual(states);
    expect(h.record().checks).toEqual({});
    expect(h.entries("event.received").at(-1)?.event.type).toBe("pr.ci.finished");
  });
});
