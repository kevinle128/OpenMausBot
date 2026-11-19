import { describe, expect, it } from "vitest";
import { PaseoConnection, RESPONDED_TTL_MS, type PaseoClientPort, type PaseoConnectionOptions } from "./connection.ts";
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

async function connected(client: FakeClient, options: Partial<PaseoConnectionOptions> = {}) {
  const connection = new PaseoConnection({ createClient: () => client, restartBackoffMs: { base: 1, max: 2 }, ...options });
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

  it("keeps an answered request muted until the daemon drops it, and reports it resolved once", async () => {
    const client = new FakeClient();
    const { connection, seen } = await connected(client);
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p1"]) } });
    await connection.respondToPermission("a1", "p1", { behavior: "allow" });
    // The daemon has not dropped it yet, and a later update carries it again.
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p1"]) } });
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p1", "p2"]) } });
    expect(seen).toEqual(["requested a1/p1", "requested a1/p2"]);
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p2"]) } });
    expect(seen).toEqual(["requested a1/p1", "requested a1/p2", "resolved a1/p1"]);
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p2"]) } });
    expect(seen).toHaveLength(3);
    await connection.stop();
  });

  it("does not report an answered request again from a snapshot taken before the daemon dropped it", async () => {
    const client = new FakeClient();
    const { connection, seen } = await connected(client);
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p1"]) } });
    await connection.respondToPermission("a1", "p1", { behavior: "deny" });
    client.observer?.snapshot({ entries: [{ agent: agent("a1", ["p1"]) } as never], pageInfo: { hasMore: false } });
    expect(seen).toEqual(["requested a1/p1"]);
    await connection.stop();
  });

  it("reports a request again when the daemon still lists it after the mute ends", async () => {
    let clock = 1_000;
    const client = new FakeClient();
    const { connection, seen } = await connected(client, { now: () => clock });
    client.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", ["p1"]) } });
    await connection.respondToPermission("a1", "p1", { behavior: "allow" });
    clock += RESPONDED_TTL_MS + 1;
    client.observer?.snapshot({ entries: [{ agent: agent("a1", ["p1"]) } as never], pageInfo: { hasMore: false } });
    expect(seen).toEqual(["requested a1/p1", "requested a1/p1"]);
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

describe("PaseoConnection.agentContext", () => {
  it("never takes a notice or a message of ours for the first prompt of the person, and does not fall back to the tail", async () => {
    const client = new FakeClient() as FakeClient & { fetchAgentTimeline?: PaseoClientPort["fetchAgentTimeline"]; sendAgentMessage?: PaseoClientPort["sendAgentMessage"] };
    const pages: Record<string, Array<{ item: { type: string; text?: string; name?: string; detail?: { type: string; command?: string } } }>> = {
      after: [
        { item: { type: "user_message", text: "already approved ak secrets: API_KEY" } },
        { item: { type: "user_message", text: "already approved omb secrets: API_KEY\n\n𝗯𝘆 𝗢𝗠𝗕" } },
        { item: { type: "user_message", text: "something we sent" } },
        { item: { type: "user_message", text: "Clean the build folder" } },
      ],
      tail: [{ item: { type: "tool_call", name: "Bash", detail: { type: "shell", command: "ls build" } } }],
    };
    client.fetchAgentTimeline = async (_id, options) => ({ entries: pages[options?.direction ?? "tail"]! });
    client.sendAgentMessage = async () => {};
    const { connection } = await connected(client);
    await connection.sendMessage("a1", "something we sent");
    expect(await connection.agentContext("a1")).toEqual({ firstPrompt: "Clean the build folder", recent: ["Bash: ls build"] });
    pages.after = [{ item: { type: "user_message", text: "already approved ak secrets: API_KEY" } }];
    pages.tail = [{ item: { type: "user_message", text: "Clean the build folder" } }];
    expect(await connection.agentContext("a1")).toEqual({ recent: [] });
    await connection.stop();
  });

  describe("inspectPath", () => {
    const withInspect = () => new FakeClient() as FakeClient & { inspectPath?: PaseoClientPort["inspectPath"] };
    it("returns what the daemon answers for the path of the agent's directory", async () => {
      const client = withInspect();
      const calls: Array<[string, string]> = [];
      client.inspectPath = async (cwd, path) => {
        calls.push([cwd, path]);
        return { exists: true, kind: "symlink", size: 9, error: null };
      };
      const { connection } = await connected(client);
      expect(await connection.inspectPath("/work", "link.txt")).toEqual({ exists: true, kind: "symlink", size: 9, error: null });
      expect(calls).toEqual([["/work", "link.txt"]]);
      await connection.stop();
    });

    it("rejects when the daemon is not connected", async () => {
      const connection = new PaseoConnection({ createClient: () => new FakeClient() });
      await expect(connection.inspectPath("/work", "a")).rejects.toThrow("not connected");
    });

    it("rejects when the client does not know the request", async () => {
      const { connection } = await connected(new FakeClient());
      await expect(connection.inspectPath("/work", "a")).rejects.toThrow("cannot inspect a path");
      await connection.stop();
    });

    it("rejects when the daemon does not answer in time, even if the client keeps waiting", async () => {
      const client = withInspect();
      client.inspectPath = () => new Promise(() => {});
      const { connection } = await connected(client, { inspectTimeoutMs: 20 });
      await expect(connection.inspectPath("/work", "a")).rejects.toThrow("did not answer");
      await connection.stop();
    });

    it("passes the failure of a daemon that does not know the request", async () => {
      const client = withInspect();
      client.inspectPath = async () => {
        throw new Error("Message validation failed");
      };
      const { connection } = await connected(client);
      await expect(connection.inspectPath("/work", "a")).rejects.toThrow("Message validation failed");
      await connection.stop();
    });
  });
});
