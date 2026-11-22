import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noneAttached, type AttachedAdapters } from "./adapters/switched.ts";
import { createOrchestratorCore, type OrchestratorCore } from "./core.ts";
import type { NotifierPort } from "./ports.ts";
import { openOrchestratorStore } from "./store.ts";
import { counterIds, DEFAULT_PR_KEY, ev, fakeClock, SHA_A, SHA_B } from "./testing/builders.ts";
import { creation, fakeRuntime, FAKE_OWNER } from "./testing/fake-runtime.ts";
import { recordingPorts } from "./testing/recording-ports.ts";
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

  it("eventsAfter returns PR events in order without rawRef", async () => {
    writeFileSync(configPath(), JSON.stringify({ enabled: true }));
    const session = open();
    session.core.start();
    const thread = {
      ...ev.opened(),
      type: "chat.message.posted",
      subject: { kind: "thread", id: "t1" },
      subjectKey: "subject:github-event:thread:t1",
      data: {},
    };
    receive(session, ev.opened(), thread, ev.ciFinished());
    await session.run();
    const events = session.core.eventsAfter(0, 10);
    expect(session.core.status(false).counts.receivedByStatus).toMatchObject({ applied: 3, failed: 0 });
    expect(events.map(item => item.event.type)).toEqual(["pr.opened", "pr.ci.finished"]);
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
    expect(events[0]!.connector).toBe("github-event");
    expect(events[0]!.event).not.toHaveProperty("rawRef");
    expect(events[1]!.event).not.toHaveProperty("rawRef");
    expect(session.core.latestEvents(1).map(item => item.event.type)).toEqual(["pr.ci.finished"]);
    expect(session.core.prStatus(DEFAULT_PR_KEY)?.owner).toBeNull();
    receive(session, ev.pushed());
    expect(session.core.eventsAfter(0, 10)).toHaveLength(2);
    expect(session.core.headSeq()).toBeGreaterThan(events[1]!.seq);
  });

  it("a drain that applies rows calls the listener once", async () => {
    writeFileSync(configPath(), JSON.stringify({ enabled: true }));
    const session = open();
    session.core.start();
    let calls = 0;
    const stop = session.core.onApplied(() => { calls += 1; });
    receive(session, ev.opened(), ev.ciFinished());
    await session.run();
    expect(calls).toBe(1);
    await session.run();
    expect(calls).toBe(1);
    stop();
    receive(session, ev.pushed());
    await session.run();
    expect(calls).toBe(1);
  });
});

describe("orchestrator core with the real due timer", () => {
  it("starts no command before start repairs the commands that were running", async () => {
    const store = openOrchestratorStore(dbPath());
    store.insertCommand({
      id: "waiting", subjectKey: "subject:test-hook:thread:t1", type: "Notify", routineId: "test", idemKey: "waiting", status: "pending", outcome: null,
      approvalId: null, attempts: 0, nextAt: 0, createdAt: 0, updatedAt: 0, payload: { type: "Notify", kind: "merged" }, result: null, lastError: null,
    });
    // Left running by a stop that never finished it: only start's repair makes it due again.
    store.markCommandRunning("waiting", 1);
    store.close();

    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const core = createOrchestratorCore({
      dbPath: dbPath(), configPath: configPath(),
      handlers: { Notify: async () => { calls += 1; await gate; return { outcome: "succeeded" }; } },
    });
    cores.push(core);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls).toBe(0);
    core.start();
    await vi.waitFor(() => expect(calls).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(calls).toBe(1);
    release();
    await vi.waitFor(() => expect(core.status(false).counts.commands).toEqual([{ status: "done", outcome: "succeeded", count: 1 }]));
  });
});

describe("orchestrator core adapters", () => {
  const ADAPTERS_ON = { adapters: { forge: { github: { enabled: true }, gitlab: { enabled: true } }, notifier: { enabled: true }, runtime: { enabled: true } } };
  const start = (doc: Record<string, unknown>, attached: () => AttachedAdapters) => {
    writeFileSync(configPath(), JSON.stringify({ enabled: true, ...doc }));
    const session = open({ attached });
    session.core.start();
    return session;
  };

  /** A notifier that records its cards; adopt answers what the test sets. */
  function fakeNotifier() {
    const recording = recordingPorts().ports.notifier;
    const seen = { cards: [] as Array<{ kind: string; decisionId: string }>, adopted: [] as string[], reconciled: [] as string[][], adoptAnswer: true };
    const port: NotifierPort = {
      card: async (kind, payload, answers) => {
        seen.cards.push({ kind, decisionId: payload.decisionId });
        return recording.card(kind, payload, answers).then(() => ({ cardId: `card-${seen.cards.length}` }));
      },
      notice: recording.notice,
      adopt: cardId => { seen.adopted.push(cardId); return seen.adoptAnswer; },
      reconcile: ids => { seen.reconciled.push([...ids].sort()); },
    };
    return { port, seen };
  }
  /** Lets a finished resume clear its guard before the next call. */
  const resumed = (core: OrchestratorCore) => {
    core.resumeCards();
    return new Promise<void>(resolve => setTimeout(resolve, 5));
  };
  const attachedWith = (patch: Partial<AttachedAdapters>) => () => ({ ...noneAttached(), ...patch });

  it("binds an owner once when the runtime reports the same creation twice", async () => {
    const runtime = fakeRuntime();
    const session = start(ADAPTERS_ON, attachedWith({ runtime: runtime.port }));
    runtime.create(creation("github", "acme/widgets", 1));
    runtime.create(creation("github", "acme/widgets", 1));
    const bound = () => session.core.pr(DEFAULT_PR_KEY)?.ledger.filter(row => row.entry.type === "owner.bound") ?? [];
    expect(bound()).toHaveLength(1);
    expect(session.core.pr(DEFAULT_PR_KEY)?.record.owner).toMatchObject({ agentId: FAKE_OWNER.agentId });

    runtime.create(creation("github", "acme/widgets", 1, { ...FAKE_OWNER, agentId: "agent-2" }));
    expect(bound()).toHaveLength(2);
    await session.core.stop();
    expect(runtime.subscribers()).toBe(0);
  });

  it("drops a creation report while binding owners is off", () => {
    const runtime = fakeRuntime();
    const session = start({ adapters: { runtime: { enabled: true, bindOwners: false } } }, attachedWith({ runtime: runtime.port }));
    runtime.create(creation("github", "acme/widgets", 1));
    expect(session.core.pr(DEFAULT_PR_KEY)).toBeNull();
  });

  /** A PR that waits for a decision, with its card shown by the attached notifier. */
  async function pendingDecision(notifier: ReturnType<typeof fakeNotifier>) {
    const session = start(ADAPTERS_ON, attachedWith({ notifier: notifier.port }));
    receive(session, ev.opened(), ev.reviewFinished({ status: "needs-person", head: SHA_A, reviewedSha: SHA_A }));
    await session.run();
    await vi.waitFor(() => expect(session.core.pr(DEFAULT_PR_KEY)?.record.pendingDecision).not.toBeNull());
    return session;
  }

  it("adopts the open card of a pending decision and opens it again when it is gone", async () => {
    const notifier = fakeNotifier();
    const session = await pendingDecision(notifier);
    const { decisionId } = session.core.pr(DEFAULT_PR_KEY)!.record.pendingDecision!;
    expect(notifier.seen.cards).toEqual([{ kind: "decision", decisionId }]);

    notifier.seen.adoptAnswer = true;
    notifier.seen.reconciled.length = 0;
    await resumed(session.core);
    await vi.waitFor(() => expect(notifier.seen.reconciled).toEqual([[decisionId]]));
    expect(notifier.seen.adopted).toContain("card-1");
    expect(notifier.seen.cards).toHaveLength(1);

    notifier.seen.adoptAnswer = false;
    notifier.seen.reconciled.length = 0;
    await resumed(session.core);
    await vi.waitFor(() => expect(notifier.seen.reconciled).toEqual([[decisionId]]));
    expect(notifier.seen.cards).toHaveLength(2);
    const asked = session.core.pr(DEFAULT_PR_KEY)!.commands.find(command => command.type === "AskPerson");
    expect(asked?.result).toEqual({ outcome: "succeeded", detail: { cardId: "card-2" } });
    // The next restart adopts the new card, not the old one.
    notifier.seen.adoptAnswer = true;
    notifier.seen.adopted.length = 0;
    notifier.seen.reconciled.length = 0;
    await resumed(session.core);
    await vi.waitFor(() => expect(notifier.seen.reconciled).toEqual([[decisionId]]));
    expect(notifier.seen.adopted).toEqual(["card-2"]);
  });

  it("resumes no card for an answered decision", async () => {
    const notifier = fakeNotifier();
    const session = await pendingDecision(notifier);
    const { decisionId } = session.core.pr(DEFAULT_PR_KEY)!.record.pendingDecision!;
    session.core.inputs.answer(DEFAULT_PR_KEY, decisionId, "Leave it as it is");
    notifier.seen.adopted.length = 0;
    notifier.seen.reconciled.length = 0;
    notifier.seen.adoptAnswer = false;
    await resumed(session.core);
    await vi.waitFor(() => expect(notifier.seen.reconciled).toEqual([[]]));
    expect(notifier.seen.adopted).toEqual([]);
    expect(notifier.seen.cards).toHaveLength(1);
  });

  it("closes the card of an approval whose held command was dropped", async () => {
    const notifier = fakeNotifier();
    // oxlint-disable-next-line unicorn/no-thenable -- a routine's action list is named "then" in the config document
    const ask = { id: "ask-merge", name: "Merge after approval", when: { on: ["pr.opened"] }, then: [{ do: "Merge", askFirst: true }], once: "per-pr" };
    const session = start({ ...ADAPTERS_ON, routines: { useDefaults: false, custom: [ask] } }, attachedWith({ notifier: notifier.port }));
    receive(session, ev.opened());
    await session.run();
    await vi.waitFor(() => expect(session.core.pr(DEFAULT_PR_KEY)?.record.pendingDecision?.kind).toBe("approve_action"));
    const { decisionId } = session.core.pr(DEFAULT_PR_KEY)!.record.pendingDecision!;
    notifier.seen.reconciled.length = 0;
    await resumed(session.core);
    await vi.waitFor(() => expect(notifier.seen.reconciled).toEqual([[decisionId]]));

    receive(session, ev.pushed({ head: SHA_B, after: SHA_B }));
    await session.run();
    expect(session.core.pr(DEFAULT_PR_KEY)?.record.pendingDecision).toBeNull();
    notifier.seen.reconciled.length = 0;
    await resumed(session.core);
    await vi.waitFor(() => expect(notifier.seen.reconciled).toEqual([[]]));
  });

  it("does nothing for cards while the notifier switch is off", async () => {
    const notifier = fakeNotifier();
    const session = start({}, attachedWith({ notifier: notifier.port }));
    await resumed(session.core);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(notifier.seen.reconciled).toEqual([]);
  });

  it("runs a routine test with every switch on and adapters attached without calling any adapter", async () => {
    const recording = recordingPorts();
    const runtime = fakeRuntime();
    const notifier = fakeNotifier();
    const session = start({ ...ADAPTERS_ON, routines: { useDefaults: false } }, attachedWith({
      forge: { github: recording.ports.forge.github, gitlab: recording.ports.forge.gitlab }, notifier: notifier.port, runtime: runtime.port,
    }));
    receive(session, ev.opened());
    await session.run();
    const inputSeq = session.core.pr(DEFAULT_PR_KEY)!.ledger.find(row => row.entry.type === "event.received")!.seq;
    await new Promise(resolve => setTimeout(resolve, 20));
    const calls = recording.calls.length;
    const cards = notifier.seen.cards.length;

    // oxlint-disable-next-line unicorn/no-thenable -- a routine's action list is named "then" in the config document
    const draft = { id: "try-everything", name: "Try everything", when: { on: ["pr.opened"] }, once: "per-trigger", then: [
      { do: "Notify", params: { kind: "merged" } }, { do: "TellOwner", params: { template: "merged" } }, { do: "Merge" }, { do: "RefreshDetails" },
      { do: "AskPerson", params: { kind: "decision" } }, { do: "Instruct", params: { to: "new-agent", prompt: "Look at {{repo}}" } },
    ] };
    const result = await session.core.testRoutine({ routine: draft, prKey: DEFAULT_PR_KEY, inputSeq });
    expect(result.matched).toBe(true);
    expect(result.actions.map(action => action.action)).toEqual(["Notify", "TellOwner", "Merge", "RefreshDetails", "AskPerson", "Instruct"]);
    expect(result.actions.every(action => action.payload !== undefined)).toBe(true);
    expect(recording.calls).toHaveLength(calls);
    expect(notifier.seen.cards).toHaveLength(cards);
    expect(runtime.sent).toEqual([]);
    expect(runtime.spawned).toEqual([]);
  });
});
