import { SECRETS_APPROVAL_NOTICE_PREFIX, type PaseoConnection } from "./connection.ts";
import { agentTitle, createLiveAgents, type LiveAgent, type LiveAgents } from "./live-agents.ts";
import { ORIGIN_TTL_MS } from "./auto-approval.ts";

export type NoticeResult = "sent" | "queued" | "none";

export interface ApprovedSecret {
  ref: string;
  /** The program path of an exec approval; it tells two approvals of one ref apart and is never sent. */
  program?: string;
  /** Set only when OpenMausBot approved by itself; the notice then says so. */
  by?: "omb";
  /** The secret is in OpenMausBot's Vault. The notice says `omb secrets`. */
  vault?: "omb";
  /** The Paseo agent to tell, when the caller named it. Used as given, only if it is listed now; no other agent is guessed. */
  agentId?: string;
}

/** Paseo shows user messages as plain text, so Markdown bold would print its asterisks; this is Unicode sans-serif bold for "by OMB". */
export const BY_OMB_LINE = "\u{1D5EF}\u{1D606} \u{1D5E2}\u{1D5E0}\u{1D5D5}";

type Port = Pick<PaseoConnection, "on" | "off" | "sendMessage">;

/** The agent that was told, for the history line. */
export interface NoticedAgent {
  agentId: string;
  title: string;
  cwd: string;
}

export interface NoticeOutcome {
  result: NoticeResult;
  agent?: NoticedAgent;
}

/** The fixed text told to the agent: only the ref, which passed the ref-name check. Never text an agent wrote. */
export function approvalNoticeText(approved: ApprovedSecret): string {
  const text = `${SECRETS_APPROVAL_NOTICE_PREFIX} ${approved.ref}`;
  return approved.by === "omb" ? `${text}\n\n${BY_OMB_LINE}` : text;
}

/**
 * Tells the Paseo agent named on an approved Vault secret request that it can go on. The agent is used as given, and
 * only if it is listed now; no other agent is guessed. A running agent is never interrupted: its message waits until
 * it is idle, for at most ten minutes.
 */
export function createApprovalNotifier(deps: { connection: Port; agents?: LiveAgents; log(message: string): void; now?: () => number }) {
  const now = deps.now ?? Date.now;
  // Created before the listener below, so an agent is listed by the time its idle update is handled.
  const agents = deps.agents ?? createLiveAgents(deps.connection);
  const ownAgents = deps.agents === undefined;
  const queued = new Map<string, { agentId: string; text: string; until: number }>();
  const sentKeys = new Map<string, number>();

  const onUpdate = (agent: LiveAgent) => {
    if (agent.status === "idle") void flush(agent.id);
  };
  const onRemoved = (agentId: string) => {
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

  return {
    async approved(approved: ApprovedSecret): Promise<NoticeOutcome> {
      expire();
      const named = approved.agentId ? agents.get(approved.agentId) : undefined;
      const agent = named ? { agentId: named.id, title: agentTitle(named), cwd: named.cwd ?? "" } : null;
      if (!agent) return { result: "none" };
      const { agentId } = agent;
      const text = approvalNoticeText(approved);
      const key = `omb|${agentId}|${approved.ref}|${approved.program ?? ""}`;
      if (sentKeys.has(key) || queued.has(key)) return { result: "none", agent };
      sentKeys.set(key, now() + ORIGIN_TTL_MS);
      if (agents.get(agentId)?.status === "idle") {
        await deliver(key, agentId, text);
        return { result: "sent", agent };
      }
      queued.set(key, { agentId, text, until: now() + ORIGIN_TTL_MS });
      return { result: "queued", agent };
    },
    stop(): void {
      deps.connection.off("agentUpdate", onUpdate as never);
      deps.connection.off("agentRemoved", onRemoved);
      if (ownAgents) agents.stop();
      queued.clear();
    },
  };
}

export type ApprovalNotifier = ReturnType<typeof createApprovalNotifier>;
