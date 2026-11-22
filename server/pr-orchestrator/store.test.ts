import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { openOrchestratorStore, type OrchestratorStore } from "./store.ts";
import type { CommandRecord, CommandResult, LedgerEntry, PrRecord, TimerRecord } from "./types.ts";

const stores: OrchestratorStore[] = [];
const dirs: string[] = [];
const open = (path = ":memory:") => { const s = openOrchestratorStore(path); stores.push(s); return s; };
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-pr-orchestrator-"));
  dirs.push(dir);
  return join(dir, "nested", "pr-orchestrator.db");
};
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) removeTempDir(d);
});

const received = (eventId: string, receivedAt = 1_000, subjectKey: string | null = "github:acme/app#1") => ({
  eventId, connector: "github-event", subjectKey, subjectKind: "pr", kind: "pr.opened", receivedAt, occurredAt: null,
  status: "pending" as const, reason: null, json: `{"id":"${eventId}"}`,
});

const refreshEntry: LedgerEntry = { type: "timer.cancelled", timerId: "t", kind: "merge.window", routineId: "r" };
const matched = (routineId: string): LedgerEntry => ({
  type: "routine.matched", routineId, trigger: "pr.opened", triggerSeq: 1, actions: [],
});
const ledgerRow = (subjectKey: string, at: number, entry: LedgerEntry = refreshEntry) =>
  ({ subjectKey, at, configVersion: "v1", causationSeq: null, entry });

function pr(key: string, patch: Partial<PrRecord> = {}): PrRecord {
  const [provider, rest] = key.split(":") as ["github" | "gitlab", string];
  const [repo, number] = rest.split("#");
  return {
    key, provider, repo, number: Number(number), url: null, title: null, branch: null, baseRef: null, author: null,
    headSha: "a", headSetAt: 1, draft: false, state: "open", stateSince: 1, owner: null, checks: {}, review: null, forge: null,
    conflict: false, activeRuns: {}, pendingDecision: null, lastAnswer: null, createdAt: 1, updatedAt: 1, lastSeq: 1, ...patch,
  };
}

function command(id: string, patch: Partial<CommandRecord> = {}): CommandRecord {
  return {
    id, subjectKey: "github:acme/app#1", type: "Notify", routineId: "r", idemKey: `idem-${id}`, status: "pending", outcome: null,
    approvalId: null, attempts: 0, nextAt: 100, createdAt: 10, updatedAt: 10, payload: { type: "Notify", kind: "merged" },
    result: null, lastError: null, ...patch,
  };
}

function timer(id: string, patch: Partial<TimerRecord> = {}): TimerRecord {
  return {
    id, subjectKey: "github:acme/app#1", kind: "merge.window", idemKey: `idem-${id}`, dueAt: 500, createdAt: 10, state: "armed",
    payload: { routineId: "r" }, ...patch,
  };
}

describe.each([["memory", () => open()], ["file", () => open(tempFile())]])("orchestrator store on %s", (_name, make) => {
  it("stores a repeated event id once and reports only the new ids", () => {
    const store = make();
    expect(store.insertReceived([received("e1"), received("e2")])).toEqual(["e1", "e2"]);
    expect(store.insertReceived([received("e2"), received("e3")])).toEqual(["e3"]);
    expect(store.countReceivedByStatus()).toEqual({ pending: 3, applied: 0, failed: 0 });
  });

  it("returns pending received events in arrival order", () => {
    const store = make();
    store.insertReceived([received("late", 3_000), received("early", 1_000), received("other", 2_000, null)]);
    const pending = store.receivedByStatus("pending", 10);
    expect(pending.map((r) => r.eventId)).toEqual(["late", "early", "other"]);
    expect(pending[0]?.prKey).toBe("github:acme/app#1");
    expect(pending[2]?.prKey).toBeNull();
    store.setReceivedStatus(pending[0]!.seq, "applied", null);
    expect(store.receivedByStatus("pending", 10).map((r) => r.eventId)).toEqual(["early", "other"]);
    expect(store.receivedByStatus("pending", 1)).toHaveLength(1);
    expect(store.lastReceivedAt()).toBe(3_000);
  });

  it("appends ledger rows with increasing seq and reads them back per PR in order", () => {
    const store = make();
    const a = store.append(ledgerRow("github:acme/app#1", 1));
    const other = store.append(ledgerRow("github:acme/app#2", 2));
    const b = store.append({ ...ledgerRow("github:acme/app#1", 3), causationSeq: a });
    expect(b).toBeGreaterThan(other);
    expect(other).toBeGreaterThan(a);
    const rows = store.ledger("github:acme/app#1");
    expect(rows.map((r) => r.seq)).toEqual([a, b]);
    expect(rows[1]).toMatchObject({ causationSeq: a, configVersion: "v1", entry: refreshEntry });
    expect(store.ledger("github:acme/app#1", a).map((r) => r.seq)).toEqual([b]);
    expect(store.ledgerKeys().sort()).toEqual(["github:acme/app#1", "github:acme/app#2"]);
    store.putPr(pr("github:acme/app#2"));
    expect(store.ledgerKeys({ prOnly: true })).toEqual(["github:acme/app#2"]);
  });

  it("round-trips a PR record and lists newest update first", () => {
    const store = make();
    store.putPr(pr("github:acme/app#1", { updatedAt: 5 }));
    store.putPr(pr("github:acme/app#2", { updatedAt: 9, state: "ci_failed" }));
    store.putPr(pr("github:acme/app#1", { updatedAt: 7, state: "ready" }));
    expect(store.getPr("github:acme/app#1")).toMatchObject({ state: "ready", updatedAt: 7 });
    expect(store.getPr("github:acme/app#3")).toBeNull();
    expect(store.listPrs({ limit: 10 }).map((p) => p.key)).toEqual(["github:acme/app#2", "github:acme/app#1"]);
    expect(store.listPrs({ state: "ready", limit: 10 }).map((p) => p.key)).toEqual(["github:acme/app#1"]);
    expect(store.countPrsByState()).toEqual({ ready: 1, ci_failed: 1 });
  });

  it("refuses a second command with the same idempotency key", () => {
    const store = make();
    expect(store.insertCommand(command("c1", { idemKey: "same" }))).toBe(true);
    expect(store.insertCommand(command("c2", { idemKey: "same" }))).toBe(false);
    expect(store.getCommand("c2")).toBeNull();
    expect(store.insertTimer(timer("t1", { idemKey: "same-timer" }))).toBe(true);
    expect(store.insertTimer(timer("t2", { idemKey: "same-timer" }))).toBe(false);
  });

  it("never hands out a command that awaits approval until it is released", () => {
    const store = make();
    store.insertCommand(command("held", { status: "awaiting_approval", approvalId: "d1" }));
    expect(store.dueCommands(1_000, 10)).toEqual([]);
    expect(store.nextCommandAt()).toBeNull();
    expect(store.commandAwaiting("d1")?.id).toBe("held");
    expect(store.awaitingFor("github:acme/app#1").map((c) => c.id)).toEqual(["held"]);
    store.releaseCommand("held", 400);
    expect(store.commandAwaiting("d1")).toBeNull();
    expect(store.dueCommands(1_000, 10)).toMatchObject([{ id: "held", status: "pending", approvalId: null, nextAt: 400 }]);
  });

  it("lists one routine's runs across subjects, newest first", () => {
    const store = make();
    const first = store.append(ledgerRow("github:acme/app#1", 1, matched("fix")));
    store.append(ledgerRow("github:acme/app#1", 2, matched("other")));
    const last = store.append(ledgerRow("subject:hook:issue:7", 3, matched("fix")));
    expect(store.routineRuns("fix", 10).map((r) => r.seq)).toEqual([last, first]);
    expect(store.routineRuns("fix", 1).map((r) => r.seq)).toEqual([last]);
  });

  it("reports a connector's last event, 24 hour count, last error and signature failures", () => {
    const store = make();
    const now = 10 * 24 * 3_600_000;
    store.insertReceived([received("old", now - 30 * 3_600_000), received("new", now - 3_600_000)]);
    store.logConnector({ connector: "github-event", at: now - 5_000, outcome: "accepted", count: 2 });
    store.logConnector({ connector: "github-event", at: now - 4_000, outcome: "rejected", count: 1, detail: "wrong forge" });
    store.logConnector({ connector: "github-event", at: now - 3_000, outcome: "bad_signature", count: 1 });
    store.logConnector({ connector: "github-event", at: now - 2_000, outcome: "bad_signature", count: 1 });
    store.logConnector({ connector: "github-event", at: now - 40 * 3_600_000, outcome: "bad_signature", count: 1 });
    store.logConnector({ connector: "gitlab-event", at: now - 1_000, outcome: "error", count: 1, detail: "elsewhere" });
    expect(store.connectorStatus("github-event", now)).toEqual({
      lastEventAt: now - 3_600_000, events24h: 1, lastError: "bad_signature", lastErrorAt: now - 2_000, signatureFailures24h: 2,
    });
    expect(store.connectorStatus("quiet", now)).toEqual({
      lastEventAt: null, events24h: 0, lastError: null, lastErrorAt: null, signatureFailures24h: 0,
    });
  });

  it("keeps one cursor per connector", () => {
    const store = make();
    expect(store.cursor("poll")).toBeNull();
    store.saveCursor("poll", "c1", 10);
    store.saveCursor("poll", "c2", 20);
    store.saveCursor("other", "x", 30);
    expect(store.cursor("poll")).toEqual({ cursor: "c2", updatedAt: 20 });
    expect(store.cursor("other")).toEqual({ cursor: "x", updatedAt: 30 });
  });

  it("finds the workflow command by its run ref", () => {
    const store = make();
    const payload = {
      type: "RunWorkflow" as const, guard: "workflow:ci-fix", workflow: "ci-fix", connection: null, headSha: "a", message: "m", vars: {}, untrusted: {},
    };
    store.insertCommand(command("run", { type: "RunWorkflow", payload }));
    store.insertCommand(command("other", { type: "RunWorkflow", payload }));
    store.markCommandRunning("run", 20);
    store.finishCommand("run", { outcome: "succeeded", detail: { runRef: "run-42" } }, 30);
    expect(store.commandByRunRef("run-42")).toMatchObject({ id: "run", status: "done", outcome: "succeeded", attempts: 1 });
    expect(store.commandByRunRef("run-43")).toBeNull();
  });

  it("hands out at most one due command per PR and none for a PR with a running command", () => {
    const store = make();
    store.insertCommand(command("a1", { createdAt: 1 }));
    store.insertCommand(command("a2", { createdAt: 2 }));
    store.insertCommand(command("b1", { subjectKey: "github:acme/app#2", createdAt: 3 }));
    store.insertCommand(command("c1", { subjectKey: "github:acme/app#3", createdAt: 4 }));
    store.insertCommand(command("c2", { subjectKey: "github:acme/app#3", createdAt: 5, nextAt: 9_999 }));
    expect(store.dueCommands(1_000, 10).map((c) => c.id)).toEqual(["a1", "b1", "c1"]);
    expect(store.dueCommands(1_000, 2).map((c) => c.id)).toEqual(["a1", "b1"]);
    store.markCommandRunning("a1", 50);
    expect(store.dueCommands(1_000, 10).map((c) => c.id)).toEqual(["b1", "c1"]);
    expect(store.dueCommands(50, 10)).toEqual([]);
  });

  it("puts running commands back to pending on reset", () => {
    const store = make();
    store.insertCommand(command("r1"));
    store.insertCommand(command("r2", { subjectKey: "github:acme/app#2" }));
    store.markCommandRunning("r1", 20);
    store.markCommandRunning("r2", 20);
    store.finishCommand("r2", { outcome: "failed", reason: "boom", retryable: false }, 25);
    expect(store.getCommand("r2")).toMatchObject({ status: "done", outcome: "failed", lastError: "boom" });
    expect(store.resetRunningCommands(60)).toBe(1);
    expect(store.getCommand("r1")).toMatchObject({ status: "pending", attempts: 1, updatedAt: 60 });
    store.markCommandRunning("r1", 70);
    store.rescheduleCommand("r1", 900, "try later", 80);
    expect(store.getCommand("r1")).toMatchObject({ status: "pending", nextAt: 900, lastError: "try later", attempts: 2 });
    expect(store.countCommands()).toEqual(expect.arrayContaining([
      { status: "pending", outcome: null, count: 1 }, { status: "done", outcome: "failed", count: 1 },
    ]));
  });

  it("returns the earliest next time across pending commands and armed timers", () => {
    const store = make();
    expect(store.nextCommandAt()).toBeNull();
    expect(store.nextTimerAt()).toBeNull();
    store.insertCommand(command("late", { nextAt: 700 }));
    store.insertCommand(command("soon", { nextAt: 300 }));
    store.insertTimer(timer("t-late", { dueAt: 900 }));
    store.insertTimer(timer("t-soon", { dueAt: 400 }));
    expect(store.nextCommandAt()).toBe(300);
    expect(store.nextTimerAt()).toBe(400);
    expect(store.countArmedTimers()).toBe(2);
    expect(store.dueTimers(500, 10).map((t) => t.id)).toEqual(["t-soon"]);
    store.setTimerState("t-soon", "fired");
    expect(store.nextTimerAt()).toBe(900);
    expect(store.armedTimers("github:acme/app#1", "merge.window").map((t) => t.id)).toEqual(["t-late"]);
    expect(store.timersFor("github:acme/app#1")).toHaveLength(2);
  });

  it("rolls back every write of a transaction that throws, including nested savepoints", () => {
    const store = make();
    store.setMeta("kept", "1");
    expect(() => store.transaction(() => {
      store.setMeta("outer", "1");
      store.transaction(() => { store.setMeta("inner", "1"); });
      throw new Error("boom");
    })).toThrow("boom");
    expect(store.meta("outer")).toBeNull();
    expect(store.meta("inner")).toBeNull();
    expect(store.meta("kept")).toBe("1");

    store.transaction(() => {
      store.setMeta("outer", "2");
      expect(() => store.transaction(() => { store.setMeta("inner", "2"); throw new Error("inner"); })).toThrow("inner");
    });
    expect(store.meta("outer")).toBe("2");
    expect(store.meta("inner")).toBeNull();
  });

  it("stores a config version once", () => {
    const store = make();
    store.saveConfigVersion("v1", "{}", 10);
    store.saveConfigVersion("v1", "{\"x\":1}", 20);
    expect(store.configVersion("v1")).toEqual({ firstSeenAt: 10, json: "{}" });
    expect(store.configVersion("v2")).toBeNull();
  });

  it("prunes only ended PRs past the age limit and keeps pending received events", () => {
    const store = make();
    const day = 24 * 3_600_000;
    const now = Date.now();
    const old = now - 40 * day;
    store.putPr(pr("github:acme/app#1", { state: "merged", updatedAt: old }));
    store.putPr(pr("github:acme/app#2", { state: "merged", updatedAt: now }));
    store.putPr(pr("github:acme/app#3", { state: "ci_running", updatedAt: old }));
    for (const n of [1, 2, 3]) store.append(ledgerRow(`github:acme/app#${n}`, old));
    store.append(ledgerRow("subject:hook:issue:1", old));
    store.append(ledgerRow("subject:hook:issue:2", now));
    store.append(ledgerRow("subject:hook:issue:3", old));
    store.append(ledgerRow("subject:hook:issue:3", now));
    store.append(ledgerRow("subject:hook:issue:4", old));
    // A command enters the store pending; only finishCommand makes it done.
    store.insertCommand(command("c3", { subjectKey: "subject:hook:issue:1" }));
    store.finishCommand("c3", { outcome: "skipped", reason: "test" }, old);
    store.insertCommand(command("c4", { subjectKey: "subject:hook:issue:4" }));
    store.insertCommand(command("c1", { subjectKey: "github:acme/app#1" }));
    store.insertCommand(command("c2", { subjectKey: "github:acme/app#3" }));
    store.insertTimer(timer("t1", { subjectKey: "github:acme/app#1" }));
    store.insertReceived([received("pending-old", old), received("applied-old", old), received("applied-new", now)]);
    const [pendingOld, appliedOld, appliedNew] = store.receivedByStatus("pending", 10);
    store.setReceivedStatus(appliedOld!.seq, "applied", null);
    store.setReceivedStatus(appliedNew!.seq, "applied", null);
    store.logConnector({ connector: "c", at: now - 8 * day, outcome: "error", count: 1 });
    store.logConnector({ connector: "c", at: now - day, outcome: "error", count: 1 });

    const counts = store.prune(now - 30 * day, now - 30 * day, now);
    expect(counts).toEqual({ prs: 1, subjects: 1, received: 1, connectorLog: 1 });
    expect(store.getPr("github:acme/app#1")).toBeNull();
    expect(store.getPr("github:acme/app#2")).not.toBeNull();
    expect(store.getPr("github:acme/app#3")).not.toBeNull();
    expect(store.ledgerKeys().sort()).toEqual(["github:acme/app#2", "github:acme/app#3", "subject:hook:issue:2", "subject:hook:issue:3", "subject:hook:issue:4"]);
    expect(store.ledger("subject:hook:issue:3")).toHaveLength(2);
    expect(store.commandsFor("subject:hook:issue:1")).toEqual([]);
    expect(store.commandsFor("subject:hook:issue:4")).toHaveLength(1);
    expect(store.commandsFor("github:acme/app#1")).toEqual([]);
    expect(store.commandsFor("github:acme/app#3")).toHaveLength(1);
    expect(store.timersFor("github:acme/app#1")).toEqual([]);
    expect(store.receivedByStatus("pending", 10).map((r) => r.seq)).toEqual([pendingOld!.seq]);
    expect(store.receivedByStatus("applied", 10).map((r) => r.eventId)).toEqual(["applied-new"]);
  });
});

describe("orchestrator store file", () => {
  it("creates the file owner-only and reopens an existing file without losing rows", () => {
    const path = tempFile();
    const first = openOrchestratorStore(path);
    first.setMeta("k", "v");
    first.insertReceived([received("e1")]);
    first.append(ledgerRow("github:acme/app#1", 1));
    first.close();
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

    const second = open(path);
    expect(second.meta("k")).toBe("v");
    expect(second.receivedByStatus("pending", 10)).toHaveLength(1);
    expect(second.ledger("github:acme/app#1")).toHaveLength(1);
    expect(second.path).toBe(path);
  });

  it("lists open questions of PRs and of other subjects and leaves answered ones out", () => {
    const store = open();
    const asked = (id: string, subjectKey: string, decisionId: string, result: CommandResult = { outcome: "succeeded", detail: { cardId: `card-${id}` } }) => {
      store.insertCommand(command(id, {
        subjectKey, type: "AskPerson", payload: { type: "AskPerson", kind: "decision", decisionId, gaps: [], gated: null },
      }));
      store.finishCommand(id, result, 20);
    };
    const answer = (decisionId: string): LedgerEntry => ({ type: "person.answered", decisionId, answer: "yes" });
    const pending = (commandId: string, decisionId: string) => ({ decisionId, kind: "decision" as const, askedAt: 1, commandId, gatedCommandId: null });

    // A PR whose pending decision names its card, and a PR with no pending decision.
    store.putPr(pr("github:acme/app#1", { pendingDecision: pending("pr-open", "d-pr") }));
    store.putPr(pr("github:acme/app#2"));
    asked("pr-open", "github:acme/app#1", "d-pr");
    asked("pr-answered", "github:acme/app#2", "d-old");
    // Subjects that are not PRs: one card with no answer, one answered, one that never showed its card.
    asked("sub-open", "subject:hook:thread:t1", "d-open");
    asked("sub-answered", "subject:hook:thread:t2", "d-done");
    store.append(ledgerRow("subject:hook:thread:t2", 5, answer("d-done")));
    asked("sub-failed", "subject:hook:thread:t3", "d-failed", { outcome: "failed", reason: "x", retryable: false });

    expect(store.openQuestions().map(({ subjectKey, decisionId, command: row }) => [subjectKey, decisionId, row.id])).toEqual([
      ["github:acme/app#1", "d-pr", "pr-open"],
      ["subject:hook:thread:t1", "d-open", "sub-open"],
    ]);
  });

  it("replaces the stored result of a finished command and nothing else", () => {
    const store = open();
    store.insertCommand(command("c1"));
    store.markCommandRunning("c1", 15);
    store.setCommandResult("c1", { outcome: "succeeded", detail: { cardId: "late" } });
    expect(store.getCommand("c1")).toMatchObject({ status: "running", result: null });
    store.finishCommand("c1", { outcome: "succeeded", detail: { cardId: "first" } }, 20);
    store.setCommandResult("c1", { outcome: "succeeded", detail: { cardId: "again" } });
    expect(store.getCommand("c1")).toMatchObject({ status: "done", outcome: "succeeded", result: { outcome: "succeeded", detail: { cardId: "again" } } });
  });
});
