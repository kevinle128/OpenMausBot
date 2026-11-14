import { describe, expect, it } from "vitest";
import { PaseoConnection, type PaseoClientPort } from "./connection.ts";
import { paseoMcpServerEntry, paseoMcpUrl } from "./mcp-config.ts";

type Status = Parameters<Parameters<PaseoClientPort["subscribeConnectionStatus"]>[0]>[0];
type Observer = Parameters<ReturnType<PaseoClientPort["observeAgents"]>["subscribe"]>[0];

class FakeClient implements PaseoClientPort {
  authFailureReason: string | null = null;
  observer: Observer | null = null;
  responses: [string, string][] = [];
  closed = false;
  private listener: ((status: Status) => void) | null = null;

  async connect() {
    this.listener?.({ status: "connected" });
  }
  async close() {
    this.closed = true;
  }
  subscribeConnectionStatus(listener: (status: Status) => void) {
    this.listener = listener;
    return () => {};
  }
  observeAgents() {
    return {
      ready: Promise.resolve({}),
      subscribe: (observer: Observer) => {
        this.observer = observer;
        return () => {};
      },
      release: async () => {},
    };
  }
  onAgentAttentionRequired() {
    return () => {};
  }
  async respondToPermission(agentId: string, requestId: string) {
    this.responses.push([agentId, requestId]);
  }
  status(status: Status) {
    this.listener?.(status);
  }
}

const agent = (id: string, pending: string[]) =>
  ({ id, pendingPermissions: pending.map((requestId) => ({ id: requestId, name: "Bash" })) }) as never;

async function connected(client: FakeClient) {
  const connection = new PaseoConnection({ createClient: () => client, restartBackoffMs: { base: 1, max: 2 } });
  const seen: string[] = [];
  connection.on("permissionRequested", ({ agentId, request }) => seen.push(`requested ${agentId}/${request.id}`));
  connection.on("permissionResolved", ({ agentId, requestId }) => seen.push(`resolved ${agentId}/${requestId}`));
  connection.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { connection, seen };
}

describe("PaseoConnection", () => {
  it("reports permissions already pending in the first snapshot, once", async () => {
    const client = new FakeClient();
    const { connection, seen } = await connected(client);
    client.observer?.snapshot({ entries: [{ agent: agent("a1", ["p1"]) } as never], pageInfo: { hasMore: false } });
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p1"]) } });
    expect(seen).toEqual(["requested a1/p1"]);
    await connection.stop();
  });

  it("reports a resolved permission when an update no longer lists it", async () => {
    const client = new FakeClient();
    const { connection, seen } = await connected(client);
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p1"]) } });
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", []) } });
    expect(seen).toEqual(["requested a1/p1", "resolved a1/p1"]);
    await connection.stop();
  });

  it("reports pending permissions again after a reconnect snapshot", async () => {
    const client = new FakeClient();
    const { connection, seen } = await connected(client);
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p1"]) } });
    client.status({ status: "disconnected", reason: "lost" });
    client.status({ status: "connected" });
    client.observer?.snapshot({ entries: [{ agent: agent("a1", ["p1"]) } as never], pageInfo: { hasMore: false } });
    expect(seen).toEqual(["requested a1/p1", "requested a1/p1"]);
    await connection.stop();
  });

  it("refuses to answer while disconnected and answers while connected", async () => {
    const client = new FakeClient();
    const { connection } = await connected(client);
    await connection.respondToPermission("a1", "p1", { behavior: "allow" });
    expect(client.responses).toEqual([["a1", "p1"]]);
    client.status({ status: "disconnected" });
    await expect(connection.respondToPermission("a1", "p2", { behavior: "allow" })).rejects.toThrow("not connected");
    await connection.stop();
  });

  it("starts a fresh client after the daemon refuses the credential", async () => {
    const clients: FakeClient[] = [];
    const connection = new PaseoConnection({
      createClient: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
      restartBackoffMs: { base: 1, max: 2 },
    });
    connection.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    clients[0]!.authFailureReason = "incorrect_password";
    clients[0]!.status({ status: "disconnected", reason: "Incorrect password" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clients.length).toBeGreaterThan(1);
    expect(clients[0]!.closed).toBe(true);
    await connection.stop();
  });
});

describe("Paseo MCP entry", () => {
  it("points at the daemon's /mcp/agents and adds a bearer only for a password", () => {
    expect(paseoMcpUrl("ws://127.0.0.1:6767/ws")).toBe("http://127.0.0.1:6767/mcp/agents");
    expect(paseoMcpServerEntry()).toEqual({ type: "http", url: "http://127.0.0.1:6767/mcp/agents" });
    expect(paseoMcpServerEntry({ daemonPassword: "pw" }).headers).toEqual({ Authorization: "Bearer pw" });
  });
});
