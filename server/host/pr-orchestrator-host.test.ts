import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validFixtures } from "../pr-orchestrator/contract/conformance/index.ts";
import { signBatch } from "../pr-orchestrator/signature.ts";
import { VaultStore } from "../vault-store.ts";
import { createWebhookIngressHandler } from "../webhook-ingress.ts";
import type { WebhookManager } from "../webhooks.ts";
import { createPrOrchestratorHost, type PrOrchestratorHost } from "./pr-orchestrator-host.ts";

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

  it("reports the door off and reopens nothing while stopped", async () => {
    const { host, base } = await serve();
    host.start();
    await host.stop();
    writeConfig();
    vault.saveSecret({ name: "GITHUB_EVENT_HUB_SECRET", value: HUB_KEY, source: "settings", bots: "all" });
    expect((await post(base, HUB_KEY)).status).toBe(404);
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
    expect((await post(base, HUB_KEY)).status).toBe(404);
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
    await stopped;
    expect((await post(base, HUB_KEY)).status).toBe(200);
  });

  it("stops at once when no core was ever opened", async () => {
    const { host } = await serve();
    host.start();
    await expect(host.stop()).resolves.toBeUndefined();
  });
});
