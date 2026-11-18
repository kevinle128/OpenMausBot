import { akSecretsRequestRef } from "./permission-rules.ts";

/** One thing OpenMausBot allowed without asking the person. It never holds a secret value or file content. */
export interface AutoApproval {
  /** The same key for the same agent and the same thing, so repeats become one line. */
  key: string;
  agent: string;
  workspace: string;
  what: string;
  /** A fixed rule id. */
  rule: string;
  /** More that belongs in the line but not in the key that merges repeats, such as the scores of a model's answer. */
  detail?: string;
  /** Set when the person answered the card: the line names their answer instead of a rule. */
  answer?: PersonAnswer;
}

/** What the person answered on a card: allow, deny, or the label of the choice they picked. */
export type PersonAnswer = { decision: "allow" | "deny" } | { choice: string };

export type AutoApprovalHistory = (entry: AutoApproval) => void;

/** What the Inbox takes to write one history line (see `place-inbox.ts`). */
export interface AutoApprovalLine {
  botId: string;
  threadId: string;
  key: string;
  text(count: number): string;
}

/** The text of the history line; `count` is how many times the same thing was allowed in the last hour. */
export function formatAutoApproval(entry: AutoApproval, count: number): string {
  const { answer } = entry;
  const head = !answer ? "✓ OpenMausBot tự duyệt" : "choice" in answer ? `✓ Bạn đã chọn: ${answer.choice}` : answer.decision === "allow" ? "✓ Bạn đã duyệt" : "✗ Bạn đã từ chối";
  return [
    `${head}${count > 1 ? ` (${count} lần)` : ""}`,
    `Agent: ${entry.agent}`,
    `Workspace: ${entry.workspace}`,
    `Việc: ${entry.what}`,
    ...(answer ? [] : [`Luật: ${entry.rule}`]),
    ...(entry.detail ? [`Jev: ${entry.detail}`] : []),
  ].join("\n");
}

export const ORIGIN_TTL_MS = 10 * 60_000;
const MAX_ORIGINS = 50;

export interface RequestOrigin {
  agentId: string;
  agent: string;
  cwd: string;
}

/** Remembers which Paseo agents sent `ak secrets request <REF>` lately, so the later approval in the `ak` inbox can name the
 * agent. It names one only when exactly one agent asked for that ref inside the window; otherwise it cannot tell. */
export function createRequestOrigins(now: () => number = Date.now) {
  const byRef = new Map<string, Map<string, RequestOrigin & { at: number }>>();
  const live = (ref: string): Array<RequestOrigin & { at: number }> => {
    const agents = byRef.get(ref);
    if (!agents) return [];
    for (const [id, one] of agents) if (now() - one.at > ORIGIN_TTL_MS) agents.delete(id);
    if (agents.size === 0) byRef.delete(ref);
    return [...agents.values()];
  };
  return {
    note(command: string, origin: RequestOrigin): void {
      const ref = akSecretsRequestRef(command);
      if (!ref) return;
      live(ref);
      const agents = byRef.get(ref) ?? new Map();
      agents.set(origin.agentId, { ...origin, at: now() });
      byRef.set(ref, agents);
      for (const old of byRef.keys()) {
        if (byRef.size <= MAX_ORIGINS) break;
        byRef.delete(old);
      }
    },
    find(ref: string): RequestOrigin | null {
      const found = live(ref);
      if (found.length !== 1) return null;
      const { at: _at, ...origin } = found[0]!;
      return origin;
    },
  };
}

export type RequestOrigins = ReturnType<typeof createRequestOrigins>;
