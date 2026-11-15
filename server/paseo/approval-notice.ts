import type { PaseoConnection } from "./connection.ts";
import { ORIGIN_TTL_MS, type RequestOrigins } from "./auto-approval.ts";

export type NoticeResult = "sent" | "queued" | "none";

export interface ApprovedSecret {
  ref: string;
  /** The program path of an exec approval; it tells two approvals of one ref apart and is never sent. */
  program?: string;
}

type Port = Pick<PaseoConnection, "on" | "off" | "sendMessage" | "recentShellCommands">;
type AgentView = { id: string; status: string; updatedAt?: string | number | Date };

/** The fixed text told to the agent: only the ref, which passed the ref-name check. Never text an agent wrote. */
export function approvalNoticeText(approved: ApprovedSecret): string {
  return `already approved ak secrets: ${approved.ref}`;
}

/** True when `command` runs `ak secrets` and names the ref as a whole word. */
export function commandNamesRef(command: string, ref: string): boolean {
  if (!/\bak\s+secrets\s+/.test(command)) return false;
  return command.split(/[\s=,;|&"'()]+/).includes(ref);
}

/**
 * Tells the Paseo agent that waited for an `ak` approval that it can go on. The agent is the one that was seen running
 * `ak secrets` for the ref (or the only recently active one whose last commands name it); with none or several, nobody is told.
 * A running agent is never interrupted: its message waits until it is idle, for at most ten minutes.
 */
export function createApprovalNotifier(deps: { connection: Port; origins: Pick<RequestOrigins, "find">; log(message: string): void; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const agents = new Map<string, AgentView>();
  const queued = new Map<string, { agentId: string; text: string; until: number }>();
  const sentKeys = new Map<string, number>();

  const onUpdate = (agent: AgentView) => {
    agents.set(agent.id, agent);
    if (agent.status === "idle") void flush(agent.id);
  };
  const onRemoved = (agentId: string) => {
    agents.delete(agentId);
    for (const [key, one] of queued) if (one.agentId === agentId) queued.delete(key);
  };
  deps.connection.on("agentUpdate", onUpdate as never);
  deps.connection.on("agentRemoved", onRemoved);

  function expire(): void {
    for (const [key, one] of queued) if (one.until <= now()) queued.delete(key);
    for (const [key, until] of sentKeys) if (until <= now()) sentKeys.delete(key);
  }

  async function deliver(key: string, agentId: string, text: string): Promise<void> {
    queued.delete(key);
    try {
      await deps.connection.sendMessage(agentId, text);
    } catch (error) {
      deps.log(`paseo approval notice: could not tell agent ${agentId} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  async function flush(agentId: string): Promise<void> {
    expire();
    for (const [key, one] of queued) if (one.agentId === agentId && agents.get(agentId)?.status === "idle") await deliver(key, agentId, one.text);
  }

  async function findAgent(ref: string): Promise<string | null> {
    const known = deps.origins.find(ref);
    if (known) return known.agentId;
    const since = now() - ORIGIN_TTL_MS;
    const recent = [...agents.values()].filter((agent) => {
      const at = agent.updatedAt === undefined ? now() : new Date(agent.updatedAt).getTime();
      return Number.isFinite(at) && at >= since;
    });
    const matches: string[] = [];
    for (const agent of recent) {
      try {
        if ((await deps.connection.recentShellCommands(agent.id)).some((command) => commandNamesRef(command, ref))) matches.push(agent.id);
      } catch (error) {
        deps.log(`paseo approval notice: could not read the commands of agent ${agent.id} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  }

  return {
    async approved(approved: ApprovedSecret): Promise<NoticeResult> {
      expire();
      const agentId = await findAgent(approved.ref);
      if (!agentId) return "none";
      const text = approvalNoticeText(approved);
      const key = `${agentId}|${approved.ref}|${approved.program ?? ""}`;
      if (sentKeys.has(key) || queued.has(key)) return "none";
      sentKeys.set(key, now() + ORIGIN_TTL_MS);
      if (agents.get(agentId)?.status === "idle") {
        await deliver(key, agentId, text);
        return "sent";
      }
      queued.set(key, { agentId, text, until: now() + ORIGIN_TTL_MS });
      return "queued";
    },
    stop(): void {
      deps.connection.off("agentUpdate", onUpdate as never);
      deps.connection.off("agentRemoved", onRemoved);
      queued.clear();
    },
  };
}

export type ApprovalNotifier = ReturnType<typeof createApprovalNotifier>;
