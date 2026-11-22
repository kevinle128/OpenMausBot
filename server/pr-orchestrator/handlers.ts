import type { AgentRuntimePort, ForgePort, NotifierPort, OwnerResolver, SignalInterpreter, WorkflowRuntimePort } from "./ports.ts";
import type { CommandRecord, CommandResult, CommandType, CommandWait, Owner, PrRecord, Provider, RepoConfig } from "./types.ts";

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
  /** Records owner.bound for this PR. A no-op for a subject that is not a PR. */
  bindOwner(owner: Owner): void;
  /** True when the port's switch is on, whether or not its adapter is attached yet. */
  installed: { forge(provider: Provider): boolean; notifier: boolean; runtime: boolean };
  /** `<repo>#<number>` for a PR; for another subject, the label of its last event, else `<kind>:<id>`. */
  subjectLabel: string;
  /** The merge commit that the forge's pr.merged event reported, or "" when no such event is stored. */
  mergeSha: string;
  log(line: string): void;
  /** Seconds before a waiting command runs again: for a port that cannot be reached, and for a forge that has not computed a fact. */
  wait: { portSeconds: number; forgeSeconds: number };
}

export type CommandHandler = (command: CommandRecord, ctx: CommandContext) => Promise<CommandResult | CommandWait>;
export type CommandHandlers = Record<CommandType, CommandHandler>;

const notInstalled = async (): Promise<CommandResult> => ({ outcome: "skipped", reason: "not installed" });

/** Every command is recorded as not performed until a real handler replaces its entry. */
export function stubHandlers(): CommandHandlers {
  return {
    TellOwner: notInstalled, AskPerson: notInstalled, Merge: notInstalled, Notify: notInstalled,
    RefreshDetails: notInstalled, RunWorkflow: notInstalled, RunInstruction: notInstalled,
  };
}
