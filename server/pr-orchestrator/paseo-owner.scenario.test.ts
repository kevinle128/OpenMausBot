import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPrOrchestratorHost, type PrOrchestratorHost } from "../host/pr-orchestrator-host.ts";
import { PaseoConnection } from "../paseo/connection.ts";
import { VaultStore } from "../vault-store.ts";
import { writeConnectorSecret } from "./connector-secrets.ts";
import { createWebhookIngressHandler } from "../webhook-ingress.ts";
import type { WebhookManager } from "../webhooks.ts";
import { validFixtures } from "./contract/conformance/index.ts";
import { signBatch } from "./signature.ts";
import { openOrchestratorStore } from "./store.ts";
import { agentSnapshot, FakePaseoClient } from "./testing/fake-paseo-client.ts";

const HUB_KEY = "fake-hub-key-for-paseo-scenario-0123456789";
const PR_KEY = "github:acme/widgets#42";
const CONFIG = {
  enabled: true,
  connectors: { "github-event": { use: "github-event", enabled: true } },
  adapters: { runtime: { enabled: true } },
  commands: { backoffSeconds: { initial: 1, max: 1 } },
  routines: { useDefaults: true },
};

let dir: string;
let host: PrOrchestratorHost;
let server: Server;
let connection: PaseoConnection;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "paseo-owner-scenario-")); });
afterEach(async () => {
  await connection?.stop();
  await new Promise<void>(resolve => { server?.closeAllConnections(); server?.close(() => resolve()); });
  await host?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const event = (type: string) => validFixtures().find(item => item.type === type)!.event;

async function post(base: string, events: unknown[]): Promise<void> {
  const body = JSON.stringify({ v: 1, events });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const answer = await fetch(`${base}/events/github-event`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-omb-timestamp": timestamp, "x-omb-signature": signBatch(Buffer.from(HUB_KEY), timestamp, Buffer.from(body)) },
  });
  expect(answer.status).toBe(200);
}

describe("Paseo owner scenario", () => {
  it("binds the creating session and sends it the merged message at once, while its turn runs", async () => {
    const vault = new VaultStore({ dataDir: dir });
    writeConnectorSecret(join(dir, "pr-orchestrator-secrets.json"), "github-event", HUB_KEY);
    const configPath = join(dir, "pr-orchestrator.json");
    writeFileSync(configPath, JSON.stringify(CONFIG));
    const past = new Date(Date.now() - 3_000);
    utimesSync(configPath, past, past);

    host = createPrOrchestratorHost({ dataDir: dir, vault });
    server = createServer((req, res) => { void createWebhookIngressHandler({} as WebhookManager, undefined, host.door)(req, res); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const client = new FakePaseoClient();
    connection = new PaseoConnection({ createClient: () => client, restartBackoffMs: { base: 1, max: 2 } });
    const sentSpy = vi.spyOn(client, "sendAgentMessage");
    host.attach({ paseo: connection });
    host.start();
    connection.start();
    await vi.waitFor(() => expect(client.observer).not.toBeNull());

    // A parent session, and a child that it started, which is the one that runs the PR command.
    const parent = agentSnapshot("parent", { status: "running" });
    const child = agentSnapshot("child", { status: "running", labels: { "paseo.parent-agent-id": "parent" } });
    client.snapshot([parent, child]);
    await post(base, [event("pr.opened")]);

    client.timelines.child = [{ type: "tool_call", name: "Bash", detail: { type: "shell", command: "gh pr create --fill", output: "https://github.com/acme/widgets/pull/42\n", exitCode: 0 } }];
    // The connect scan has read both timelines already. The end of the child's turn makes the next read, which finds the call.
    await vi.waitFor(() => expect(client.timelineReads).toBe(2));
    client.update({ ...child, status: "idle" });
    await vi.waitFor(() => expect(client.timelineReads).toBe(3), { timeout: 5_000 });
    await new Promise(resolve => setTimeout(resolve, 50));

    // The parent runs a turn when the PR is merged. The first send reaches the daemon, and its answer is lost.
    client.update({ ...parent, status: "running" });
    client.failAfterAccept = true;
    await post(base, [event("pr.merged")]);
    await vi.waitFor(() => expect(sentSpy.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });

    expect(client.sent).toHaveLength(1);
    const [first] = client.sent;
    expect(first!.agentId).toBe("parent");
    expect(first!.text).toContain("acme/widgets#42");
    expect(first!.text).toContain("is merged");
    expect(first!.options).toEqual({ messageId: expect.stringMatching(/^.+:[0-9a-f]{16}$/), activeTurnBehavior: "steer" });
    // The retry carries the same id and text: the daemon's receipt takes it and sends nothing new.
    expect(sentSpy.mock.calls[1]).toEqual(sentSpy.mock.calls[0]);
    expect(client.repeats).toBe(1);
    expect(JSON.stringify(sentSpy.mock.calls)).not.toContain("interrupt");
    for (const [, , options] of sentSpy.mock.calls) {
      expect(options).not.toHaveProperty("sourceAgentId");
      expect((options as { activeTurnBehavior?: string }).activeTurnBehavior).toBe("steer");
    }

    await connection.stop();
    await host.stop();
    const store = openOrchestratorStore(join(dir, "pr-orchestrator.db"));
    try {
      expect(store.getPr(PR_KEY as never)?.owner).toMatchObject({ runtime: "paseo", agentId: "parent", boundBy: "provenance", cwd: "/work/parent" });
      const tell = store.commandsFor(PR_KEY as never).filter(command => command.type === "TellOwner");
      expect(tell.map(command => command.outcome)).toEqual(["succeeded"]);
    } finally {
      store.close();
    }
  }, 30_000);
});
