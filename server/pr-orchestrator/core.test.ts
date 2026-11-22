import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorCore, type OrchestratorCore } from "./core.ts";
import { openOrchestratorStore } from "./store.ts";
import { counterIds, DEFAULT_PR_KEY, ev, fakeClock } from "./testing/builders.ts";
import { manualTimer } from "./testing/manual-timer.ts";
import type { CommandRecord } from "./types.ts";

let dir: string;
let cores: OrchestratorCore[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-orchestrator-core-"));
  cores = [];
});
afterEach(async () => {
  await Promise.all(cores.map(core => core.stop()));
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = () => join(dir, "pr-orchestrator.db");
const configPath = () => join(dir, "pr-orchestrator.json");

function open(overrides: Partial<Parameters<typeof createOrchestratorCore>[0]> = {}) {
  const timer = manualTimer();
  const clock = fakeClock();
  const core = createOrchestratorCore({
    dbPath: dbPath(), configPath: configPath(), now: clock.now, newId: counterIds("c"), startTimer: timer.startTimer, ...overrides,
  });
  cores.push(core);
  return { core, timer, clock, run: () => timer.options().run() };
}

function receive({ core, clock }: ReturnType<typeof open>, ...events: Array<ReturnType<typeof ev.opened>>) {
  core.intake.accept(events.map(event => ({ event, raw: "{}" })), clock.now());
}

describe("orchestrator core", () => {
  it("starts off with no config file and stores nothing until the door is used", () => {
    const { core } = open();
    core.start();
    expect(core.enabled()).toBe(false);
    expect(core.status(false).counts).toEqual({ byState: {}, receivedByStatus: { pending: 0, applied: 0, failed: 0 }, commands: [], timersArmed: 0 });
    expect(core.status(false).lastReceivedAt).toBeNull();
    expect(core.listPrs({ limit: 10 })).toEqual([]);
    expect(core.inboundInstance("github-event")).toBeNull();
    expect(core.connectors(() => false).map(connector => [connector.id, connector.enabled])).toEqual([["github-event", false], ["gitlab-event", false]]);
  });

  it("puts commands that were running at a stop back in the queue on the next start", async () => {
    const first = open();
    await first.core.stop();
    const store = openOrchestratorStore(dbPath());
    const command: CommandRecord = {
      id: "interrupted", subjectKey: DEFAULT_PR_KEY, type: "Notify", routineId: "test", idemKey: "interrupted", status: "pending", outcome: null,
      approvalId: null, attempts: 0, nextAt: 0, createdAt: 0, updatedAt: 0, payload: { type: "Notify", kind: "merged" }, result: null, lastError: null,
    };
    store.insertCommand(command);
    store.markCommandRunning(command.id, 1);
    expect(store.getCommand(command.id)?.status).toBe("running");
    store.close();

    open().core.start();
    const check = openOrchestratorStore(dbPath());
    expect(check.getCommand(command.id)).toMatchObject({ status: "pending", attempts: 1 });
    check.close();
  });

  it("uses an edited config file on the next step without a restart", async () => {
    writeFileSync(configPath(), JSON.stringify({ enabled: true }));
    const session = open();
    session.core.start();
    const first = session.core.config().version;
    receive(session, ev.opened());
    await session.run();
    expect(session.core.pr(DEFAULT_PR_KEY)?.ledger.map(row => row.configVersion)).toEqual([first, first]);

    writeFileSync(configPath(), JSON.stringify({ enabled: true, merge: { auto: false } }));
    const second = session.core.config().version;
    expect(second).not.toBe(first);
    receive(session, ev.pushed({ head: "c".repeat(40), after: "c".repeat(40) }));
    await session.run();
    const versions = session.core.pr(DEFAULT_PR_KEY)?.ledger.map(row => row.configVersion) ?? [];
    expect(versions.slice(0, 2)).toEqual([first, first]);
    expect(versions.slice(2)).toContain(second);
    expect(new Set(versions)).toEqual(new Set([first, second]));

    writeFileSync(configPath(), "{ not json");
    expect(session.core.config()).toMatchObject({ version: second, error: expect.stringContaining("JSON") });
  });

  it("reports counts, the config version and whether the secret is saved", async () => {
    writeFileSync(configPath(), JSON.stringify({ enabled: true }));
    const session = open();
    session.core.start();
    receive(session, ev.opened(), ev.ciFinished({ status: "failed" }));
    await session.run();
    const status = session.core.status(true);
    expect(status).toMatchObject({ enabled: true, configVersion: session.core.config().version, configError: null, secretPresent: true });
    expect(status.counts.receivedByStatus).toEqual({ pending: 0, applied: 2, failed: 0 });
    expect(status.counts.byState).toEqual({ ci_failed: 1 });
    expect(status.lastReceivedAt).toBe(session.clock.now());
    const [github] = session.core.connectors(name => name === "GITHUB_EVENT_HUB_SECRET");
    expect(github).toMatchObject({ id: "github-event", intakePath: "/events/github-event", secretName: "GITHUB_EVENT_HUB_SECRET", secretPresent: true });
  });

  it("lists the resolved routines with their sentences and the last runs of one routine", async () => {
    writeFileSync(configPath(), JSON.stringify({ enabled: true }));
    const session = open();
    session.core.start();
    const routines = session.core.routines();
    expect(routines.length).toBeGreaterThan(5);
    expect(routines.find(routine => routine.id === "tell-owner-conflict")).toMatchObject({
      source: "default", describe: expect.stringContaining("When a merge conflict is detected"),
    });

    receive(session, ev.opened(), ev.conflict());
    await session.run();
    const runs = session.core.routineRuns("tell-owner-conflict");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ prKey: DEFAULT_PR_KEY, trigger: "pr.conflict.detected" });
    expect(runs[0]?.actions[0]).toMatchObject({ action: "TellOwner", result: "issued" });
  });
});

describe("orchestrator core with the real due timer", () => {
  it("starts no command before start repairs the commands that were running", async () => {
    const store = openOrchestratorStore(dbPath());
    store.insertCommand({
      id: "waiting", subjectKey: "subject:test-hook:thread:t1", type: "Notify", routineId: "test", idemKey: "waiting", status: "pending", outcome: null,
      approvalId: null, attempts: 0, nextAt: 0, createdAt: 0, updatedAt: 0, payload: { type: "Notify", kind: "merged" }, result: null, lastError: null,
    });
    store.close();

    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const core = createOrchestratorCore({
      dbPath: dbPath(), configPath: configPath(),
      handlers: { Notify: async () => { calls += 1; await gate; return { outcome: "succeeded" }; } },
    });
    cores.push(core);
    core.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(calls).toBe(1);
    release();
    await vi.waitFor(() => expect(core.status(false).counts.commands).toEqual([{ status: "done", outcome: "succeeded", count: 1 }]));
  });
});
