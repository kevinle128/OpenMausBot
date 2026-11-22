import { resolveForRepo } from "./config.ts";
import type { CommandHandlers, CommandHandler, OrchestratorPorts } from "./handlers.ts";
import { NotInstalledError } from "./ports.ts";
import type { ProcessManager } from "./process-manager.ts";
import type { OrchestratorStore } from "./store.ts";
import { subjectConfig } from "./subject-step.ts";
import type { CommandRecord, CommandResult, OrchestratorConfig, PrRecord } from "./types.ts";

export interface CommandBusDeps {
  store: OrchestratorStore;
  pm: ProcessManager;
  handlers: CommandHandlers;
  ports: OrchestratorPorts;
  config(): OrchestratorConfig;
  now(): number;
  log(line: string): void;
  /** Called after a command settles, so the scheduler looks for the next due work. */
  onSettled?(): void;
}

export interface CommandBus {
  /** Starts the due commands that fit in the concurrency limit; returns how many it started. The handlers run on in the background. */
  runDue(): Promise<number>;
  inFlight(): number;
  /** Resolves when no handler runs. */
  idle(): Promise<void>;
}

const SUBJECT_PREFIX = "subject:";
const MS = 1000;

export function createCommandBus(deps: CommandBusDeps): CommandBus {
  const { store, pm } = deps;
  const running = new Set<Promise<void>>();

  async function call(handler: CommandHandler, command: CommandRecord, record: PrRecord | null, now: number): Promise<CommandResult> {
    const config = deps.config();
    try {
      return await handler(command, { record, config: record ? resolveForRepo(config, record.provider, record.repo) : subjectConfig(config), now, ports: deps.ports });
    } catch (error) {
      if (error instanceof NotInstalledError) return { outcome: "skipped", reason: "not installed" };
      return { outcome: "failed", reason: error instanceof Error ? error.message : String(error), retryable: true };
    }
  }

  async function execute(command: CommandRecord): Promise<void> {
    const record = command.subjectKey.startsWith(SUBJECT_PREFIX) ? null : store.getPr(command.subjectKey);
    if (record === null && !command.subjectKey.startsWith(SUBJECT_PREFIX)) {
      store.finishCommand(command.id, { outcome: "skipped", reason: "pr gone" }, deps.now());
      deps.log(`pr-orchestrator: ${command.type} ${command.id} skipped (pr gone)`);
      return;
    }
    const result = await call(deps.handlers[command.type], command, record, deps.now());
    const { commands } = deps.config();
    const attempts = command.attempts + 1;
    try {
      if (result.outcome === "failed" && result.retryable && attempts < commands.maxAttempts) {
        const seconds = Math.min(commands.backoffSeconds.initial * 2 ** (attempts - 1), commands.backoffSeconds.max);
        store.rescheduleCommand(command.id, deps.now() + seconds * MS, result.reason, deps.now());
      } else pm.finishCommand(command, result);
      deps.log(`pr-orchestrator: ${command.type} ${command.id} ${result.outcome} (attempt ${attempts})`);
    } catch (error) {
      deps.log(`pr-orchestrator: ${command.type} ${command.id} could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    async runDue() {
      const room = deps.config().commands.concurrency - running.size;
      if (room <= 0) return 0;
      const due = store.dueCommands(deps.now(), room);
      for (const command of due) {
        store.markCommandRunning(command.id, deps.now());
        const task: Promise<void> = execute(command).catch(error => {
          deps.log(`pr-orchestrator: ${command.type} ${command.id} failed to run: ${error instanceof Error ? error.message : String(error)}`);
        }).finally(() => {
          running.delete(task);
          deps.onSettled?.();
        });
        running.add(task);
      }
      return due.length;
    },
    inFlight: () => running.size,
    async idle() {
      while (running.size > 0) await Promise.all(running);
    },
  };
}
