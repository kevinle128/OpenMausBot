import { APPROVAL_NOTICE_PREFIX, OMB_APPROVAL_NOTICE_PREFIX, type PaseoConnection } from "./connection.ts";
import { agentTitle, createLiveAgents, type LiveAgent, type LiveAgents } from "./live-agents.ts";
import { ORIGIN_TTL_MS, type RequestOrigins } from "./auto-approval.ts";

export type NoticeResult = "sent" | "queued" | "none";

export interface ApprovedSecret {
  ref: string;
  /** The program path of an exec approval; it tells two approvals of one ref apart and is never sent. */
  program?: string;
  /** Set only when OpenMausBot approved by itself; the notice then says so. */
  by?: "omb";
  /** `omb`: the secret is in OpenMausBot's Vault, and the notice says `omb secrets`. Absent: `ak secrets`. */
  vault?: "omb";
  /** The Paseo agent to tell, when the caller named it. Used as given, only if it is listed now; no other agent is guessed. */
  agentId?: string;
}

/** Paseo shows user messages as plain text, so Markdown bold would print its asterisks; this is Unicode sans-serif bold for "by OMB". */
export const BY_OMB_LINE = "\u{1D5EF}\u{1D606} \u{1D5E2}\u{1D5E0}\u{1D5D5}";

type Port = Pick<PaseoConnection, "on" | "off" | "sendMessage" | "recentShellCommands">;

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
  const text = `${approved.vault === "omb" ? OMB_APPROVAL_NOTICE_PREFIX : APPROVAL_NOTICE_PREFIX} ${approved.ref}`;
  return approved.by === "omb" ? `${text}\n\n${BY_OMB_LINE}` : text;
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
export function createApprovalNotifier(deps: { connection: Port; origins: Pick<RequestOrigins, "find">; agents?: LiveAgents; log(message: string): void; now?: () => number }) {
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

  async function findAgent(ref: string): Promise<NoticedAgent | null> {
    const known = deps.origins.find(ref);
    if (known) return { agentId: known.agentId, title: known.agent, cwd: known.cwd };
    const since = now() - ORIGIN_TTL_MS;
    const recent = agents.all().filter((agent) => {
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
    if (matches.length !== 1) return null;
    const agent = agents.get(matches[0]!)!;
    return { agentId: agent.id, title: agentTitle(agent), cwd: agent.cwd ?? "" };
  }

  return {
    async approved(approved: ApprovedSecret): Promise<NoticeOutcome> {
      expire();
      const named = approved.agentId ? agents.get(approved.agentId) : undefined;
      const agent = approved.agentId ? (named ? { agentId: named.id, title: agentTitle(named), cwd: named.cwd ?? "" } : null) : await findAgent(approved.ref);
      if (!agent) return { result: "none" };
      const { agentId } = agent;
      const text = approvalNoticeText(approved);
      const key = `${agentId}|${approved.ref}|${approved.program ?? ""}`;
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
