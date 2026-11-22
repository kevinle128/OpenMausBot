import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { eventCount } from "./app-events.ts";
import { HELD_EVENT_LIMIT, HELD_EVENT_MS } from "./app-event-sources.ts";
import { brokerClient } from "./app-trigger-broker.ts";
import { AppTriggerManager, DEFAULT_MAX_PENDING_RUNS, type AppTriggerManagerOptions } from "./app-triggers.ts";
import type { LedgerEventForBot } from "./pr-orchestrator/core.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";

let dir = "";
let broker: BrokerFake | null = null;
afterEach(async () => {
  await broker?.close();
  broker = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function event(over: { seq?: number; id?: string; type?: string; repo?: string; author?: string; receivedAt?: number } = {}): LedgerEventForBot {
  const id = over.id ?? `evt-${over.seq ?? 1}`;
  return {
    seq: over.seq ?? 1, connector: "github-event", receivedAt: over.receivedAt ?? 10_000,
    event: {
      v: 1, id, type: over.type ?? "pr.ci.finished", occurredAt: "2026-11-22T03:00:00Z",
      source: { connector: "github-event" }, connector: "github-event", key: `github-event:${id}`,
      subjectKey: `github:${over.repo ?? "acme/widgets"}#42`,
      subject: { kind: "pr", forge: "github", repo: over.repo ?? "acme/widgets", number: 42 },
      data: { author: over.author ?? "octocat" },
    },
  } as LedgerEventForBot;
}

class Feed {
  head = 0;
  rows: LedgerEventForBot[] = [];
  eventsAfter(seq: number, limit: number) { return this.rows.filter((row) => row.seq > seq).sort((a, b) => a.seq - b.seq).slice(0, limit); }
  latestEvents(limit: number) { return [...this.rows].sort((a, b) => b.seq - a.seq).slice(0, limit); }
  prStatus() { return { ci: { settled: true, failing: [] } } as never; }
  headSeq() { return this.head; }
}

function queue() {
  const items: Array<{ id: string; webhookId: string; deliveryId: string; prompt: string; status: string; same: boolean }> = [];
  const receipts: Array<{ webhookId: string; deliveryId: string; runId: string }> = [];
  const remember = (webhookId: string, deliveryId: string, runId: string) => receipts.push({ webhookId, deliveryId, runId });
  return {
    items,
    enqueue(input: { webhookId: string; deliveryId: string; prompt: string; sameConversation?: boolean }) {
      const seen = receipts.find((receipt) => receipt.webhookId === input.webhookId && receipt.deliveryId === input.deliveryId);
      if (seen) return { id: seen.runId };
      const id = `run-${items.length + 1}`;
      items.push({ id, webhookId: input.webhookId, deliveryId: input.deliveryId, prompt: input.prompt, status: "queued", same: input.sameConversation === true });
      remember(input.webhookId, input.deliveryId, id);
      return { id };
    },
    merge(webhookId: string, deliveryId: string, same: boolean, merge: (prompt: string) => string | null) {
      const seen = receipts.find((receipt) => receipt.webhookId === webhookId && receipt.deliveryId === deliveryId);
      if (seen) return { id: seen.runId };
      const run = [...items].reverse().find((candidate) => candidate.webhookId === webhookId && candidate.status === "queued" && candidate.same === same);
      const next = run ? merge(run.prompt) : null;
      if (!run || next === null) return null;
      run.prompt = next;
      remember(webhookId, deliveryId, run.id);
      return { id: run.id };
    },
    receipt(webhookId: string, deliveryId: string) {
      const seen = receipts.find((receipt) => receipt.webhookId === webhookId && receipt.deliveryId === deliveryId);
      return seen ? { id: seen.runId } : null;
    },
    pending(webhookId: string) { return items.filter((run) => run.webhookId === webhookId && ["queued", "running", "waiting"].includes(run.status)).length; },
    cancelQueued(webhookId: string) { for (const run of items) if (run.webhookId === webhookId && run.status === "queued") run.status = "cancelled"; },
  };
}

function harness(options: { now?: () => number; service?: AppTriggerManagerOptions["service"]; broker?: AppTriggerManagerOptions["broker"]; connected?: AppTriggerManagerOptions["connectedApps"] } = {}) {
  dir = mkdtempSync(join(tmpdir(), "omb-event-source-pump-"));
  const feed = new Feed();
  const runs = queue();
  let now = 10_000;
  const triggers = new AppTriggerManager({
    file: join(dir, "app-triggers.json"),
    broker: options.broker ?? { triggerTypes: async () => ({}), triggerType: async () => null, create: async () => { throw new Error("broker"); }, setEnabled: async () => { throw new Error("broker"); }, remove: async () => { throw new Error("broker"); }, inventory: async () => { throw new Error("broker"); }, poll: async () => { throw new Error("broker"); }, testEvent: async () => { throw new Error("broker"); } },
    service: options.service ?? (() => ({ available: false, reason: "off" })),
    connectedApps: options.connected ?? (async () => ({})),
    botState: () => "ready", sourceFeed: () => feed, now: options.now ?? (() => now), log: () => {}, runs,
  });
  return { feed, runs, triggers, file: join(dir, "app-triggers.json"), setNow: (value: number) => { now = value; } };
}

const CONFIG = { types: "pr.ci.finished", repos: "acme/*" };

async function automation(triggers: AppTriggerManager, name = "Valid PRs", prompt = "Merge valid pull requests.") {
  return triggers.create({ botId: "bot-1", name, prompt, app: "github-event", event: "pull_request", config: CONFIG });
}

function saved(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as { sourceCursor?: number; triggers: Array<{ id: string; held?: Array<{ id: string }> }> };
}

describe("event source pump", () => {
  it("events received before the automation was made, or before the first cursor, start no run", async () => {
    const { feed, runs, triggers } = harness();
    feed.rows = [event({ seq: 1, receivedAt: 1_000 }), event({ seq: 2, receivedAt: 1_000 })];
    feed.head = 2;
    const made = await automation(triggers);
    triggers.pumpSource();
    expect(runs.items).toEqual([]);
    expect(triggers.attempts()).toEqual([]);
    feed.rows.push(event({ seq: 3, id: "old", receivedAt: made.createdAt - 1 }));
    feed.head = 3;
    triggers.pumpSource();
    expect(runs.items).toEqual([]);
    feed.rows.push(event({ seq: 4, id: "new", receivedAt: made.createdAt }));
    feed.head = 4;
    triggers.pumpSource();
    expect(runs.items.map((run) => run.deliveryId)).toEqual(["new"]);
  });

  it("the same ledger event delivered twice gives one run and one duplicate attempt", async () => {
    const { feed, runs, triggers } = harness();
    await automation(triggers);
    const item = event({ seq: 1, id: "same" });
    triggers.receiveSourceEvents([item]);
    triggers.receiveSourceEvents([item]);
    expect(runs.items).toHaveLength(1);
    expect(triggers.attempts().map((attempt) => attempt.outcome)).toEqual(["started", "duplicate"]);
    expect(feed.head).toBe(0);
  });

  it("five CI events that arrive while a run waits join that run", async () => {
    const { runs, triggers } = harness();
    await automation(triggers);
    triggers.receiveSourceEvents([1, 2, 3, 4, 5].map((seq) => event({ seq, id: `ci-${seq}` })));
    expect(runs.items).toHaveLength(1);
    expect(eventCount(runs.items[0]!.prompt)).toBe(5);
    expect(triggers.attempts().map((attempt) => attempt.outcome)).toEqual(["started", "joined", "joined", "joined", "joined"]);
  });

  it("with three runs waiting, the cursor holds the event and delivers it when a run ends", async () => {
    const { feed, runs, triggers, file } = harness();
    feed.head = 0;
    triggers.pumpSource();
    const made = await automation(triggers);
    for (let index = 0; index < DEFAULT_MAX_PENDING_RUNS; index += 1) {
      const run = runs.enqueue({ webhookId: made.id, deliveryId: `seed-${index}`, prompt: "seed" });
      runs.items.find((item) => item.id === run.id)!.status = "running";
    }
    feed.rows = [event({ seq: 1, id: "held-event" })];
    feed.head = 1;
    triggers.pumpSource();
    expect(runs.items.map((run) => run.deliveryId)).toEqual(["seed-0", "seed-1", "seed-2"]);
    expect(saved(file).sourceCursor).toBe(1);
    expect(saved(file).triggers[0]!.held?.map((entry) => entry.id)).toEqual(["held-event"]);
    runs.items[0]!.status = "completed";
    triggers.pumpSource();
    expect(runs.items.map((run) => run.deliveryId)).toContain("held-event");
    expect(saved(file).triggers[0]!.held).toBeUndefined();
  });

  it("a paused automation records a paused skip and starts nothing", async () => {
    const { runs, triggers } = harness();
    const made = await automation(triggers);
    await triggers.update(made.id, { enabled: false });
    triggers.receiveSourceEvents([event({ seq: 1 })]);
    expect(runs.items).toEqual([]);
    expect(triggers.attempts()).toMatchObject([{ outcome: "skipped", reason: "paused" }]);
  });

  it("Test runs the latest stored event that matches, marked as a test", async () => {
    const { feed, runs, triggers } = harness();
    const made = await automation(triggers);
    feed.rows = [event({ seq: 1, id: "older" }), event({ seq: 2, id: "newer" })];
    const result = await triggers.runNow(made.id);
    expect(result).toMatchObject({ via: "here" });
    expect(runs.items[0]!.deliveryId.startsWith("test_")).toBe(true);
    expect(runs.items[0]!.prompt).toContain("nothing really happened");
    expect(runs.items[0]!.prompt).toContain("\"id\": \"newer\"");
    expect(runs.items[0]!.prompt).toContain("Event: pr.ci.finished");
  });

  it("Test with no stored match says so", async () => {
    const { triggers } = harness();
    const made = await automation(triggers);
    await expect(triggers.runNow(made.id)).rejects.toThrow("No stored event matches this automation yet. It runs on the next matching event.");
  });

  it("Test on a new automation uses an event older than the automation and starts a run with a fresh id", async () => {
    const { feed, runs, triggers } = harness();
    feed.rows = [event({ seq: 1, id: "stored", receivedAt: 1 })];
    const made = await automation(triggers);
    expect(made.createdAt).toBeGreaterThan(1);
    await triggers.runNow(made.id);
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]!.deliveryId.startsWith("test_")).toBe(true);
    expect(runs.items[0]!.deliveryId).not.toBe("stored");
  });

  it("a held event runs after a slot frees, and other automations keep receiving meanwhile", async () => {
    const { feed, runs, triggers } = harness();
    feed.head = 0;
    triggers.pumpSource();
    const full = await automation(triggers, "Full");
    const other = await triggers.create({ botId: "bot-2", name: "Other", prompt: "Tell the owner.", app: "github-event", event: "pull_request", config: CONFIG });
    for (let index = 0; index < DEFAULT_MAX_PENDING_RUNS; index += 1) {
      const run = runs.enqueue({ webhookId: full.id, deliveryId: `seed-${index}`, prompt: "seed" });
      runs.items.find((item) => item.id === run.id)!.status = "running";
    }
    feed.rows = [event({ seq: 1, id: "shared" })];
    feed.head = 1;
    triggers.pumpSource();
    expect(runs.items.filter((run) => run.webhookId === other.id).map((run) => run.deliveryId)).toEqual(["shared"]);
    expect(runs.items.filter((run) => run.webhookId === full.id).map((run) => run.deliveryId)).toEqual(["seed-0", "seed-1", "seed-2"]);
    feed.rows.push(event({ seq: 2, id: "later" }));
    feed.head = 2;
    triggers.pumpSource();
    const otherRun = runs.items.find((run) => run.webhookId === other.id);
    expect(otherRun?.deliveryId).toBe("shared");
    expect(eventCount(otherRun?.prompt)).toBe(2);
    runs.items.find((run) => run.deliveryId === "seed-0")!.status = "completed";
    triggers.pumpSource();
    expect(runs.items.filter((run) => run.webhookId === full.id).map((run) => run.deliveryId)).toContain("shared");
  });

  it("an event held for 6 hours is dropped with a recorded skip", async () => {
    const { feed, runs, triggers, setNow } = harness();
    feed.head = 0;
    triggers.pumpSource();
    const made = await automation(triggers);
    for (let index = 0; index < DEFAULT_MAX_PENDING_RUNS; index += 1) {
      const run = runs.enqueue({ webhookId: made.id, deliveryId: `seed-${index}`, prompt: "seed" });
      runs.items.find((item) => item.id === run.id)!.status = "running";
    }
    feed.rows = [event({ seq: 1, id: "stale" })];
    feed.head = 1;
    triggers.pumpSource();
    setNow(10_000 + HELD_EVENT_MS);
    triggers.pumpSource();
    expect(runs.items.map((run) => run.deliveryId)).not.toContain("stale");
    expect(triggers.attempts().some((attempt) => attempt.outcome === "skipped" && attempt.reason === "it already had 3 runs waiting for 6 hours")).toBe(true);
  });

  it("the 51st held event drops the oldest with a recorded skip", async () => {
    const { feed, runs, triggers, file } = harness();
    feed.head = 0;
    triggers.pumpSource();
    const made = await automation(triggers);
    for (let index = 0; index < DEFAULT_MAX_PENDING_RUNS; index += 1) {
      const run = runs.enqueue({ webhookId: made.id, deliveryId: `seed-${index}`, prompt: "seed" });
      runs.items.find((item) => item.id === run.id)!.status = "running";
    }
    feed.rows = Array.from({ length: HELD_EVENT_LIMIT + 1 }, (_, index) => event({ seq: index + 1, id: `held-${index + 1}` }));
    feed.head = HELD_EVENT_LIMIT + 1;
    triggers.pumpSource();
    const held = saved(file).triggers[0]!.held ?? [];
    expect(held).toHaveLength(HELD_EVENT_LIMIT);
    expect(held[0]!.id).toBe("held-2");
    expect(held.at(-1)!.id).toBe(`held-${HELD_EVENT_LIMIT + 1}`);
    expect(triggers.attempts().some((attempt) => attempt.eventId === "held-1" && attempt.outcome === "skipped" && attempt.reason === "it already had 3 runs waiting for 6 hours")).toBe(true);
  });

  it("a reprocessed row behind the cursor starts no run", async () => {
    const { feed, runs, triggers } = harness();
    await automation(triggers);
    feed.rows = [event({ seq: 1, id: "old" }), event({ seq: 2, id: "also-old" })];
    feed.head = 2;
    triggers.pumpSource();
    expect(runs.items).toEqual([]);
    feed.head = 2;
    triggers.pumpSource();
    expect(runs.items).toEqual([]);
    expect(triggers.attempts()).toEqual([]);
  });
});

describe("event source beside Composio", () => {
  it("an event-app automation is made while Composio is unavailable", async () => {
    const { triggers } = harness({ service: () => ({ available: false, reason: "unavailable" }) });
    const made = await automation(triggers);
    expect(made).toMatchObject({ app: "github-event", runOn: "maus", remote: { state: "active" }, event: "pull_request" });
    expect(made.remote.triggerId).toBeUndefined();
  });

  it("reconcile leaves event-app automations alone and still binds Composio ones", async () => {
    dir = mkdtempSync(join(tmpdir(), "omb-event-source-reconcile-"));
    broker = await startBrokerFake();
    const owner = await broker.install();
    const gmail = broker.account(owner.userId, "gmail", "sales");
    const connected = { gmail: { connected: true, accounts: [{ id: gmail, alias: "sales", status: "ACTIVE" }] } };
    let available = true;
    const triggers = new AppTriggerManager({
      file: join(dir, "app-triggers.json"),
      broker: brokerClient(() => ({ url: broker!.url, token: owner.token })),
      service: () => available ? { available: true } : { available: false, reason: "off" },
      connectedApps: async () => connected, botState: () => "ready", log: () => {},
      runs: queue(),
    });
    const mail = await triggers.create({ botId: "bot-1", name: "Mail", prompt: "Draft a reply.", app: "gmail", event: "GMAIL_NEW_GMAIL_MESSAGE" });
    expect(mail.remote.triggerId).toBeTruthy();
    broker.harness.composio.instances.delete(mail.remote.triggerId!);
    const source = await triggers.create({ botId: "bot-1", name: "PRs", prompt: "Merge valid pull requests.", app: "github-event", event: "pull_request", config: CONFIG });
    available = false;
    await triggers.reconcile();
    expect(triggers.get(source.id)?.remote).toEqual({ state: "active" });
    available = true;
    await triggers.reconcile();
    expect(triggers.get(mail.id)?.remote.state).toBe("active");
    expect(triggers.get(mail.id)?.remote.triggerId).toBeTruthy();
    expect(triggers.get(source.id)?.remote.triggerId).toBeUndefined();
    expect([...broker.harness.composio.instances.values()].some((instance) => instance.trigger_name === "pull_request")).toBe(false);
  });
});
