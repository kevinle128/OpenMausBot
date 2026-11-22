import { PortUnavailableError, type AgentRuntimePort } from "../ports.ts";
import type { Owner, Provider } from "../types.ts";

export const FAKE_OWNER: Owner = {
  runtime: "fake", hostId: "host", agentId: "agent-1", workspaceId: "ws-1", projectId: null, harness: "claude", model: "opus", cwd: "/work/owner",
  boundBy: "provenance", boundAt: 0,
};

type Creation = Parameters<Parameters<AgentRuntimePort["watchCreations"]>[0]>[0];
type SpawnRequest = Parameters<AgentRuntimePort["spawn"]>[0];

export interface FakeRuntime {
  port: AgentRuntimePort;
  sent: Array<{ owner: Owner; message: string; messageId: string }>;
  spawned: SpawnRequest[];
  /** What send answers; "down" throws like an unreachable daemon. */
  answer: "delivered" | "gone" | "down";
  alive: boolean;
  /** Plays a creation report from the runtime. */
  create(created: Creation): void;
  subscribers(): number;
}

/** A scripted runtime for the handler and switch tests. spawn is idempotent by requestId, as the real one is. */
export function fakeRuntime(): FakeRuntime {
  const watchers = new Set<(created: Creation) => void>();
  const spawnedBy = new Map<string, Owner>();
  const fake: FakeRuntime = {
    sent: [], spawned: [], answer: "delivered", alive: true,
    create: created => { for (const watcher of watchers) watcher(created); },
    subscribers: () => watchers.size,
    port: {
      runtime: "fake",
      watchCreations: callback => { watchers.add(callback); return () => { watchers.delete(callback); }; },
      async send(owner, message, opts) {
        if (fake.answer === "down") throw new PortUnavailableError("the daemon is down");
        fake.sent.push({ owner, message, messageId: opts.messageId });
        return fake.answer;
      },
      isAlive: async () => fake.alive,
      async spawn(request) {
        const known = spawnedBy.get(request.requestId);
        if (known) return known;
        fake.spawned.push(request);
        const owner = { ...FAKE_OWNER, agentId: `spawned-${fake.spawned.length}`, cwd: request.cwd, workspaceId: request.workspaceId };
        spawnedBy.set(request.requestId, owner);
        return owner;
      },
      label: async () => {},
    },
  };
  return fake;
}

export const creation = (provider: Provider, repo: string, number: number, owner: Owner = FAKE_OWNER): Creation => ({
  pr: { provider, repo, number, url: `https://example.test/${repo}/pull/${number}` }, owner, at: 0,
});
