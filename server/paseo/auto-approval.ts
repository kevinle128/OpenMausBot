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
}

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
  return [
    `✓ OpenMausBot tự duyệt${count > 1 ? ` (${count} lần)` : ""}`,
    `Agent: ${entry.agent}`,
    `Workspace: ${entry.workspace}`,
    `Việc: ${entry.what}`,
    `Luật: ${entry.rule}`,
  ].join("\n");
}

export const ORIGIN_TTL_MS = 10 * 60_000;
const MAX_ORIGINS = 50;

export interface RequestOrigin {
  agentId: string;
  agent: string;
  cwd: string;
}

/** Remembers which Paseo agent last sent `ak secrets request <REF>`, so the later approval in the `ak` inbox can name it. */
export function createRequestOrigins(now: () => number = Date.now) {
  const byRef = new Map<string, RequestOrigin & { at: number }>();
  return {
    note(command: string, origin: RequestOrigin): void {
      const ref = akSecretsRequestRef(command);
      if (!ref) return;
      byRef.delete(ref);
      byRef.set(ref, { ...origin, at: now() });
      for (const old of byRef.keys()) {
        if (byRef.size <= MAX_ORIGINS) break;
        byRef.delete(old);
      }
    },
    find(ref: string): RequestOrigin | null {
      const found = byRef.get(ref);
      if (!found) return null;
      if (now() - found.at > ORIGIN_TTL_MS) {
        byRef.delete(ref);
        return null;
      }
      const { at: _at, ...origin } = found;
      return origin;
    },
  };
}

export type RequestOrigins = ReturnType<typeof createRequestOrigins>;
