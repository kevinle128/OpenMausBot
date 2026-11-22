import { stubHandlers, type CommandHandlers, type OrchestratorPorts } from "../handlers.ts";
import type { CommandRecord, CommandResult, CommandType, Owner } from "../types.ts";

export interface RecordedCall { port: string; method: string; args: unknown[] }
type WorkflowDone = { runRef: string; outcome: "completed" | "failed" | "cancelled"; at: number };

const OWNER: Owner = {
  runtime: "recording", hostId: "host", agentId: "agent", workspaceId: null, projectId: null, harness: null, model: null, boundBy: "claim", boundAt: 0,
};

/** Ports that record every call and answer with a plain success. `finishRun` plays the workflow runtime's end-of-run report. */
export function recordingPorts(): { ports: OrchestratorPorts; calls: RecordedCall[]; finishRun(done: WorkflowDone): void } {
  const calls: RecordedCall[] = [];
  const watchers = new Set<(done: WorkflowDone) => void>();
  let counter = 0;
  const record = <T>(port: string, method: string, answer: (...args: any[]) => T) => async (...args: unknown[]): Promise<T> => {
    calls.push({ port, method, args });
    return answer(...args);
  };
  const forge = (provider: "github" | "gitlab") => ({
    provider,
    details: record(`forge.${provider}`, "details", (pr: { headSha: string | null }) => ({ headSha: pr.headSha ?? "", mergeable: true, blockers: [], requiredChecks: null, baseFailing: [], failedJobs: [] })),
    ciLog: record(`forge.${provider}`, "ciLog", () => ""),
    reviewItems: record(`forge.${provider}`, "reviewItems", () => []),
    merge: record(`forge.${provider}`, "merge", () => ({ merged: true, sha: "merged-sha" })),
    comment: record(`forge.${provider}`, "comment", () => ({})),
  });
  const ports: OrchestratorPorts = {
    forge: { github: forge("github"), gitlab: forge("gitlab") },
    runtime: {
      runtime: "recording",
      watchCreations: () => () => {},
      send: record("runtime", "send", () => "delivered" as const),
      isAlive: record("runtime", "isAlive", () => true),
      spawn: record("runtime", "spawn", () => OWNER),
      label: record("runtime", "label", () => undefined),
    },
    notifier: {
      card: record("notifier", "card", () => ({ cardId: `card-${++counter}` })),
      notice: record("notifier", "notice", () => undefined),
    },
    workflows: {
      start: record("workflows", "start", () => ({ runRef: `run-${++counter}` })),
      cancel: record("workflows", "cancel", () => undefined),
      watch: callback => { watchers.add(callback); return () => { watchers.delete(callback); }; },
    },
    resolvers: [],
    interpreters: [],
  };
  return { ports, calls, finishRun: done => { for (const watcher of watchers) watcher(done); } };
}

/** The stub handlers with the given ones in place of theirs. */
export function scriptedHandlers(script: Partial<Record<CommandType, (command: CommandRecord) => CommandResult>>): CommandHandlers {
  const handlers = stubHandlers();
  for (const type of Object.keys(script) as CommandType[]) {
    const answer = script[type] as (command: CommandRecord) => CommandResult;
    handlers[type] = async command => answer(command);
  }
  return handlers;
}
