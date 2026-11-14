import { AkError } from "./cli.ts";

/**
 * Shared by everything that calls `ak` for the Paseo bridge. `ak secrets approve` refuses to run under a coding agent and
 * writes an audit row each time it refuses, so after the first refusal every caller stops instead of retrying.
 */
export interface AkGuard {
  readonly blocked: boolean;
  /** Runs once, when the guard blocks. */
  onBlock(listener: () => void): void;
  /** True when `error` blocked the guard. Any other error is the caller's to handle. */
  report(error: unknown): boolean;
}

export function createAkGuard(log: (message: string) => void): AkGuard {
  let blocked = false;
  const listeners: Array<() => void> = [];
  return {
    get blocked() {
      return blocked;
    },
    onBlock: (listener) => void listeners.push(listener),
    report(error) {
      if (!(error instanceof AkError) || error.kind !== "agent-above-process") return false;
      if (blocked) return true;
      blocked = true;
      log("ak bridge: ak refused to run because a coding agent is above OpenMausBot in the process tree; secret sync and auto-approval are off until OpenMausBot restarts from a normal desktop session");
      for (const listener of listeners) listener();
      return true;
    },
  };
}

/** What a caller logs for an `ak` failure: the kind and ak's own error text, which never holds a secret value. */
export function describeAkError(error: unknown): string {
  return error instanceof AkError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
}
