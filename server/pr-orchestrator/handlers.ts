import type { AgentRuntimePort, ForgePort, NotifierPort, OwnerResolver, SignalInterpreter, WorkflowRuntimePort } from "./ports.ts";
import type { CommandRecord, CommandResult, CommandType, PrRecord, Provider, RepoConfig } from "./types.ts";

export interface OrchestratorPorts {
  forge: Record<Provider, ForgePort>;
  runtime: AgentRuntimePort;
  notifier: NotifierPort;
  /** Runs guarded workflows (Archon later); its watch() feeds run.finished. */
  workflows: WorkflowRuntimePort;
  resolvers: OwnerResolver[];
  interpreters: SignalInterpreter[];
}

export interface CommandContext {
  /** null for a subject that is not a PR (only the commands that accept any subject run there). */
  record: PrRecord | null;
  config: RepoConfig;
  now: number;
  ports: OrchestratorPorts;
}

export type CommandHandler = (command: CommandRecord, ctx: CommandContext) => Promise<CommandResult>;
export type CommandHandlers = Record<CommandType, CommandHandler>;

const notInstalled = async (): Promise<CommandResult> => ({ outcome: "skipped", reason: "not installed" });

/** Every command is recorded as not performed until a real handler replaces its entry. */
export function stubHandlers(): CommandHandlers {
  return {
    TellOwner: notInstalled, AskPerson: notInstalled, Merge: notInstalled, Notify: notInstalled,
    RefreshDetails: notInstalled, RunWorkflow: notInstalled, RunInstruction: notInstalled,
  };
}
