import { afterEach, describe, expect, it } from "vitest";
import type { PaseoConnection } from "../../paseo/connection.ts";
import { agentSnapshot, connectedFake, type FakePaseoClient } from "../testing/fake-paseo-client.ts";
import type { Owner } from "../types.ts";
import { createPaseoRuntime } from "./paseo-runtime.ts";

const OWNER: Owner = { runtime: "paseo", hostId: "local", agentId: "a1", workspaceId: "ws-a1", projectId: null, harness: "claude", model: "opus", cwd: "/work/a1", boundBy: "provenance", boundAt: 0 };

let stops: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of stops) await stop(); stops = []; });

async function setup() {
  const { client, connection } = await connectedFake();
  const logs: string[] = [];
  const runtime = createPaseoRuntime({ connection, log: line => logs.push(line), now: Date.now, gitlabHosts: () => ["git.oceanlabs.dev"] });
  stops.push(() => runtime.stop(), () => connection.stop());
  client.snapshot([agentSnapshot("a1")]);
  return { client, connection: connection as PaseoConnection, runtime, logs };
}

const sendsOf = (client: FakePaseoClient) => client.sent.map(({ agentId, text, options }) => ({ agentId, text, options }));

describe("Paseo runtime", () => {
  it("sends to a running owner at once as the app sends a typed message, with steer and the message id", async () => {
    const { client, runtime } = await setup();
    client.update(agentSnapshot("a1", { status: "running", pendingPermissions: [{ id: "p1", name: "Bash" }] }));
    await expect(runtime.send(OWNER, "merged", { messageId: "c1:abc" })).resolves.toBe("delivered");
    expect(sendsOf(client)).toEqual([{ agentId: "a1", text: "merged", options: { messageId: "c1:abc", activeTurnBehavior: "steer" } }]);
    expect(client.sent[0]!.options).not.toHaveProperty("sourceAgentId");
  });

  it("sends to an idle owner the same way", async () => {
    const { client, runtime } = await setup();
    await expect(runtime.send(OWNER, "hello", { messageId: "c2:def" })).resolves.toBe("delivered");
    expect(sendsOf(client)).toEqual([{ agentId: "a1", text: "hello", options: { messageId: "c2:def", activeTurnBehavior: "steer" } }]);
  });

  it("reports gone for an archived, closed or removed agent", async () => {
    const { client, runtime } = await setup();
    client.snapshot([agentSnapshot("a1"), agentSnapshot("arch", { archivedAt: "2026-11-22T00:00:00Z" }), agentSnapshot("shut", { status: "closed" }), agentSnapshot("dying")]);
    client.remove("dying");
    for (const agentId of ["arch", "shut", "dying", "never-listed"]) {
      expect(await runtime.send({ ...OWNER, agentId }, "x", { messageId: "m" })).toBe("gone");
      expect(await runtime.isAlive({ ...OWNER, agentId })).toBe(false);
    }
    expect(await runtime.isAlive(OWNER)).toBe(true);
    expect(await runtime.send({ ...OWNER, runtime: "other" }, "x", { messageId: "m" })).toBe("gone");
    expect(client.sent).toEqual([]);
  });

  it("raises runtime unavailable while the daemon is down or the list is not synced", async () => {
    const { client, runtime } = await setup();
    client.lose();
    await expect(runtime.send(OWNER, "x", { messageId: "m" })).rejects.toMatchObject({ name: "PortUnavailableError" });
    await expect(runtime.isAlive(OWNER)).rejects.toMatchObject({ name: "PortUnavailableError" });
    client.regain();
    await expect(runtime.send(OWNER, "x", { messageId: "m" })).rejects.toMatchObject({ name: "PortUnavailableError" });
    await expect(runtime.isAlive(OWNER)).rejects.toMatchObject({ name: "PortUnavailableError" });
    client.snapshot([agentSnapshot("a1")]);
    await expect(runtime.send(OWNER, "x", { messageId: "m" })).resolves.toBe("delivered");
    await expect(runtime.isAlive(OWNER)).resolves.toBe(true);
    expect(client.sent).toHaveLength(1);
  });

  it("sends nothing again when the daemon already holds the message id or its outcome is unknown", async () => {
    const { client, runtime } = await setup();
    for (const code of ["agent_request_key_conflict", "agent_request_outcome_unknown"]) {
      client.sendError = new Error(`${code}: held`);
      expect(await runtime.send(OWNER, "x", { messageId: "m" })).toBe("delivered");
    }
    client.sendError = new Error("socket reset");
    await expect(runtime.send(OWNER, "x", { messageId: "m" })).rejects.toThrow("socket reset");
    client.sendError = new Error("The Paseo daemon is not connected");
    await expect(runtime.send(OWNER, "x", { messageId: "m" })).rejects.toMatchObject({ name: "PortUnavailableError" });
  });

  it("creates a new agent with the idempotency key, the labels and the brief", async () => {
    const { client, runtime } = await setup();
    const request = { requestId: "cmd-1", cwd: "/work/a1", workspaceId: "ws-a1", harness: "claude", model: "opus", brief: "Fix the tests", labels: { "omb.command": "cmd-1" } };
    const first = await runtime.spawn(request);
    const again = await runtime.spawn(request);
    expect(client.created[0]).toEqual({ provider: "claude", cwd: "/work/a1", workspaceId: "ws-a1", model: "opus", initialPrompt: "Fix the tests", labels: { "omb.command": "cmd-1" }, idempotencyKey: "cmd-1" });
    expect(again.agentId).toBe(first.agentId);
    expect(first).toMatchObject({ runtime: "paseo", hostId: "local", harness: "claude", cwd: "/work/a1", boundBy: "claim" });
    const bare = await runtime.spawn({ ...request, requestId: "cmd-2", workspaceId: null, model: null });
    expect(client.created[2]).not.toHaveProperty("workspaceId");
    expect(client.created[2]).not.toHaveProperty("model");
    expect(bare.agentId).not.toBe(first.agentId);
  });

  it("puts a label on the owner's agent", async () => {
    const { client, runtime } = await setup();
    await runtime.label(OWNER, "omb.pr", "acme/widgets#42");
    expect(client.labelled).toEqual([{ agentId: "a1", labels: { "omb.pr": "acme/widgets#42" } }]);
  });
});
