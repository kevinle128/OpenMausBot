import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validFixtures } from "../pr-orchestrator/contract/conformance/index.ts";
import { signBatch } from "../pr-orchestrator/signature.ts";
import { openOrchestratorStore } from "../pr-orchestrator/store.ts";
import { creation, fakeRuntime, FAKE_OWNER } from "../pr-orchestrator/testing/fake-runtime.ts";
import { VaultStore } from "../vault-store.ts";
import { createWebhookIngressHandler } from "../webhook-ingress.ts";
import type { WebhookManager } from "../webhooks.ts";
import { createPrOrchestratorHost, type PrOrchestratorHost } from "./pr-orchestrator-host.ts";

// The Paseo factory builds nothing yet; the tests give the host a scripted runtime in its place.
const scripted = vi.hoisted(() => ({ runtime: null as null | { port: unknown } }));
vi.mock("../pr-orchestrator/adapters/paseo-factory.ts", () => ({
  paseoRuntime: () => (scripted.runtime ? { runtime: scripted.runtime.port, resolvers: [], stop: () => {} } : null),
}));

const HUB_KEY = "fake-hub-key-for-host-tests-0123456789";
const ENABLED = JSON.stringify({ enabled: true, connectors: { "github-event": { use: "github-event", enabled: true } } });

let dir: string;
let vault: VaultStore;
let hosts: PrOrchestratorHost[];
let servers: Server[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-orchestrator-host-"));
  vault = new VaultStore({ dataDir: dir });
  hosts = [];
  servers = [];
});
afterEach(async () => {
  for (const server of servers) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  await Promise.all(hosts.map(host => host.stop()));
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = () => join(dir, "pr-orchestrator.db");
const configPath = () => join(dir, "pr-orchestrator.json");

/** The file is written three seconds in the past so that the settled-file cache trusts it at once. */
function writeConfig(text = ENABLED): void {
  writeFileSync(configPath(), text);
  const past = new Date(Date.now() - 3_000);
  utimesSync(configPath(), past, past);
}

async function serve() {
  const host = createPrOrchestratorHost({ dataDir: dir, vault });
  hosts.push(host);
  const server = createServer((req, res) => { void createWebhookIngressHandler({} as WebhookManager, undefined, host.door)(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { host, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function post(base: string, key: string, events: unknown[] = [validFixtures().find(item => item.type === "pr.opened")!.event]) {
  const body = JSON.stringify({ v: 1, events });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const answer = await fetch(`${base}/events/github-event`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-omb-timestamp": timestamp, "x-omb-signature": signBatch(Buffer.from(key), timestamp, Buffer.from(body)) },
  });
  return { status: answer.status, body: await answer.json().catch(() => null) as { acked?: string[] } | null };
}

/** Runs the status route; its handler reads the core before its first await, so the answer is set synchronously. */
function statusNow(host: PrOrchestratorHost): unknown {
  let body: unknown;
  void host.routes({
    path: "/api/pr-orchestrator/status", method: "GET", auth: { scopes: ["admin"] },
    json: (_res: unknown, _status: number, value: unknown) => { body = value; },
  } as unknown as Parameters<PrOrchestratorHost["routes"]>[0]);
  return body;
}

describe("PR orchestrator host", () => {
  it("opens no database until a config file exists", async () => {
    const { host, base } = await serve();
    host.start();
    expect((await post(base, HUB_KEY)).status).toBe(404);
    expect(existsSync(dbPath())).toBe(false);
  });

  it("reads the hub key from the Vault by name, ignoring case and person-owned secrets", async () => {
    writeConfig();
    const { host, base } = await serve();
    host.start();
    vault.saveSecret({ name: "github_event_hub_secret", value: HUB_KEY, source: "settings", bots: "all", person: "p_ada0000000000000000000" });
    expect((await post(base, HUB_KEY)).status).toBe(503);
    vault.saveSecret({ name: "github-event-hub-secret", value: HUB_KEY, source: "settings", bots: "all" });
    const accepted = await post(base, HUB_KEY);
    expect(accepted.status).toBe(200);
    expect(accepted.body?.acked).toHaveLength(1);
    expect((await post(base, "another-key-than-the-saved-one-0123456")).status).toBe(401);
  });

  it("starts the core on the first request after the config file appears", async () => {
    vault.saveSecret({ name: "GITHUB_EVENT_HUB_SECRET", value: HUB_KEY, source: "settings", bots: "all" });
    const { host, base } = await serve();
    host.start();
    expect((await post(base, HUB_KEY)).status).toBe(404);
    writeConfig();
    expect((await post(base, HUB_KEY)).status).toBe(200);
    expect(existsSync(dbPath())).toBe(true);
  });

  it("answers 503 and reopens nothing while stopped", async () => {
    const { host, base } = await serve();
    host.start();
    await host.stop();
    writeConfig();
    vault.saveSecret({ name: "GITHUB_EVENT_HUB_SECRET", value: HUB_KEY, source: "settings", bots: "all" });
    expect((await post(base, HUB_KEY)).status).toBe(503);
    expect(existsSync(dbPath())).toBe(false);
  });

  it("starts a fresh core after a stop", async () => {
    writeConfig();
    vault.saveSecret({ name: "GITHUB_EVENT_HUB_SECRET", value: HUB_KEY, source: "settings", bots: "all" });
    const { host, base } = await serve();
    host.start();
    const first = await post(base, HUB_KEY);
    expect(first.status).toBe(200);
    await host.stop();
    expect((await post(base, HUB_KEY)).status).toBe(503);
    host.start();
    const again = await post(base, HUB_KEY);
    expect(again.status).toBe(200);
    expect(again.body?.acked).toEqual(first.body?.acked);
  });

  it("lets stop be called twice", async () => {
    writeConfig();
    const { host } = await serve();
    host.start();
    const first = host.stop();
    const second = host.stop();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await expect(host.stop()).resolves.toBeUndefined();
  });

  it("opens the next core only once the stopping one has closed", async () => {
    writeConfig();
    vault.saveSecret({ name: "GITHUB_EVENT_HUB_SECRET", value: HUB_KEY, source: "settings", bots: "all" });
    const { host, base } = await serve();
    host.start();
    expect((await post(base, HUB_KEY)).status).toBe(200);
    const stopped = host.stop();
    host.start();
    // Still in the same tick: the stopping core has not closed, so no next core may exist yet.
    expect(statusNow(host)).toEqual({ enabled: false, configured: false });
    await stopped;
    expect((await post(base, HUB_KEY)).status).toBe(200);
    expect(statusNow(host)).toMatchObject({ configured: true });
  });

  it("stops at once when no core was ever opened", async () => {
    const { host } = await serve();
    host.start();
    await expect(host.stop()).resolves.toBeUndefined();
  });

  it("the feed reads nothing while no core runs and keeps its listener across a restart", async () => {
    const { host, base } = await serve();
    let calls = 0;
    const stopListen = host.feed.subscribe(() => { calls += 1; });
    expect(host.feed.eventsAfter(0, 10)).toEqual([]);
    expect(host.feed.latestEvents(10)).toEqual([]);
    expect(host.feed.prStatus("github:acme/widgets#42")).toBeNull();
    expect(host.feed.headSeq()).toBe(0);
    expect(existsSync(dbPath())).toBe(false);

    writeConfig();
    vault.saveSecret({ name: "GITHUB_EVENT_HUB_SECRET", value: HUB_KEY, source: "settings", bots: "all" });
    host.start();
    const opened = validFixtures().find(item => item.type === "pr.opened")!.event as { id: string };
    expect((await post(base, HUB_KEY, [opened])).status).toBe(200);
    await vi.waitFor(() => expect(calls).toBe(1));
    const events = host.feed.eventsAfter(0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]!.event).not.toHaveProperty("rawRef");
    expect(events[0]!.seq).toBe(host.feed.headSeq());
    expect(host.feed.prStatus("github:acme/widgets#42")).toMatchObject({
      title: "Add the widget", owner: null, mergeable: null, number: 42,
    });
    expect(host.feed.prStatus("github:acme/widgets#42")?.gaps).not.toContain("forge_stale");

    await host.stop();
    expect(host.feed.eventsAfter(0, 10)).toEqual([]);
    expect(host.feed.latestEvents(10)).toEqual([]);
    expect(host.feed.prStatus("github:acme/widgets#42")).toBeNull();
    expect(host.feed.headSeq()).toBe(0);
    expect(calls).toBe(1);

    host.start();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    expect((await post(base, HUB_KEY, [{ ...opened, id: `${opened.id}:again` }])).status).toBe(200);
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(host.feed.eventsAfter(0, 10)).toHaveLength(2);
    stopListen();
    expect(host.feed.headSeq()).toBeGreaterThan(0);
  });

  describe("with adapters", () => {
    const KEY = "github:acme/widgets#1";
    const pr = { provider: "github" as const, repo: "acme/widgets", number: 1, url: null };
    const ledgerTypes = async (host: PrOrchestratorHost) => {
      await host.stop();
      const store = openOrchestratorStore(dbPath());
      try {
        return store.ledger(KEY).map(row => row.entry.type).filter(type => type === "owner.bound" || type === "person.answered");
      } finally {
        store.close();
      }
    };
    afterEach(() => { scripted.runtime = null; });

    it("attaches before any core exists and gives the adapters to the first core", async () => {
      const runtime = fakeRuntime();
      scripted.runtime = { port: runtime.port };
      writeConfig(JSON.stringify({ enabled: true, adapters: { runtime: { enabled: true } } }));
      const { host } = await serve();
      host.attach({});
      expect(existsSync(dbPath())).toBe(false);
      host.start();
      expect(existsSync(dbPath())).toBe(true);
      runtime.create(creation("github", "acme/widgets", 1));
      expect(await ledgerTypes(host)).toEqual(["owner.bound"]);
    });

    it("ignores a second attach", async () => {
      const lines: string[] = [];
      const host = createPrOrchestratorHost({ dataDir: dir, vault, log: line => lines.push(line) });
      hosts.push(host);
      host.attach({});
      host.attach({});
      expect(lines.filter(line => line.includes("already attached"))).toHaveLength(1);
      host.detach();
    });

    it("delivers an answer to the core that runs now, after a stop and start", async () => {
      writeConfig();
      const { host } = await serve();
      host.start();
      host.bindOwner(FAKE_OWNER, pr);
      await host.stop();
      host.start();
      host.answer(KEY, "d1", "Leave it as it is");
      expect(await ledgerTypes(host)).toEqual(["owner.bound", "person.answered"]);
    });

    it("drops an answer while stopped", async () => {
      writeConfig();
      const lines: string[] = [];
      const host = createPrOrchestratorHost({ dataDir: dir, vault, log: line => lines.push(line) });
      hosts.push(host);
      host.start();
      host.bindOwner(FAKE_OWNER, pr);
      await host.stop();
      host.answer(KEY, "d1", "Leave it as it is");
      host.bindOwner(FAKE_OWNER, pr);
      expect(lines.filter(line => line.includes("dropped"))).toHaveLength(2);
      expect(await ledgerTypes(host)).toEqual(["owner.bound"]);
    });
  });
});
