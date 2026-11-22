import type { PaseoConnection } from "../../paseo/connection.ts";

/** What the adapter keeps of a Paseo agent snapshot. */
export interface AgentInfo {
  id: string;
  provider: string | null;
  model: string | null;
  workspaceId: string | null;
  cwd: string | null;
  status: string;
  labels: Record<string, string>;
  archivedAt: string | null;
  /** Milliseconds; the time of the last snapshot when the daemon gave none. */
  updatedAt: number;
}

export interface RemovedAgent { info: AgentInfo; removedAt: number }

export const REMOVED_KEEP_MS = 6 * 60 * 60 * 1000;
export const REMOVED_KEEP_MAX = 500;

type Source = Pick<PaseoConnection, "on" | "off">;

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Reads an agent snapshot from the daemon. Every field is untrusted until it is checked here. */
export function agentInfoOf(agent: unknown, now: number): AgentInfo | null {
  if (typeof agent !== "object" || agent === null) return null;
  const raw = agent as Record<string, unknown>;
  const id = text(raw.id);
  if (id === null) return null;
  const labels: Record<string, string> = {};
  if (typeof raw.labels === "object" && raw.labels !== null) {
    for (const [key, value] of Object.entries(raw.labels)) if (typeof value === "string") labels[key] = value;
  }
  const stamp = typeof raw.updatedAt === "string" ? Date.parse(raw.updatedAt) : Number.NaN;
  return {
    id, provider: text(raw.provider), model: text(raw.model), workspaceId: text(raw.workspaceId), cwd: text(raw.cwd),
    status: text(raw.status) ?? "idle", labels, archivedAt: text(raw.archivedAt), updatedAt: Number.isFinite(stamp) ? stamp : now,
  };
}

/**
 * The agents the daemon lists now, and the ones it removed lately. A removed agent keeps its last snapshot for six hours
 * because a child agent often opens a PR and is removed minutes later, while its parent lives on.
 */
export function createAgentBook(connection: Source, now: () => number) {
  const live = new Map<string, AgentInfo>();
  const removed = new Map<string, RemovedAgent>();
  let synced = false;

  const prune = () => {
    const cutoff = now() - REMOVED_KEEP_MS;
    for (const [id, entry] of removed) if (entry.removedAt < cutoff) removed.delete(id);
    // A Map iterates in insertion order, so the first entries are the oldest.
    while (removed.size > REMOVED_KEEP_MAX) removed.delete(removed.keys().next().value as string);
  };
  const onUpdate = (agent: unknown) => {
    const info = agentInfoOf(agent, now());
    if (!info) return;
    live.set(info.id, info);
    removed.delete(info.id);
  };
  const onRemoved = (agentId: string) => {
    const info = live.get(agentId);
    live.delete(agentId);
    if (!info) return;
    removed.delete(agentId);
    removed.set(agentId, { info, removedAt: now() });
    prune();
  };
  // The daemon sends no removal for an agent that ended while OpenMausBot was away; the list after a connect starts afresh.
  const onDisconnected = () => { live.clear(); synced = false; };
  const onSynced = ({ complete }: { complete: boolean }) => { synced = complete; };
  connection.on("agentUpdate", onUpdate as never);
  connection.on("agentRemoved", onRemoved);
  connection.on("disconnected", onDisconnected as never);
  connection.on("permissionsSynced", onSynced as never);

  return {
    /** True after a complete snapshot, false after the daemon was lost. */
    get synced() { return synced; },
    live: (id: string): AgentInfo | undefined => live.get(id),
    /** A live agent, or a removed one that is still kept. */
    find(id: string): AgentInfo | undefined { prune(); return live.get(id) ?? removed.get(id)?.info; },
    isLive: (id: string): boolean => live.has(id),
    /** Both lists with the time of each agent's last change (its removal time for a removed one). */
    all(): Array<{ info: AgentInfo; changedAt: number; removed: boolean }> {
      prune();
      return [
        ...[...live.values()].map(info => ({ info, changedAt: info.updatedAt, removed: false })),
        ...[...removed.values()].map(({ info, removedAt }) => ({ info, changedAt: removedAt, removed: true })),
      ];
    },
    stop(): void {
      connection.off("agentUpdate", onUpdate as never);
      connection.off("agentRemoved", onRemoved);
      connection.off("disconnected", onDisconnected as never);
      connection.off("permissionsSynced", onSynced as never);
      live.clear();
      removed.clear();
    },
  };
}

export type AgentBook = ReturnType<typeof createAgentBook>;
