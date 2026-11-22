import { resolveForRepo } from "./config.ts";
import type { CommandContext, CommandHandlers, CommandHandler, OrchestratorPorts } from "./handlers.ts";
import { NotInstalledError, PortUnavailableError } from "./ports.ts";
import type { ProcessManager } from "./process-manager.ts";
import type { OrchestratorStore } from "./store.ts";
import { subjectConfig } from "./subject-step.ts";
import type { CommandRecord, CommandResult, CommandWait, OrchestratorConfig, PrRecord } from "./types.ts";

export interface CommandBusDeps {
  store: OrchestratorStore;
  pm: ProcessManager;
  handlers: CommandHandlers;
  ports: OrchestratorPorts;
  /** Which ports have their switch on. Absent means all of them: the ports themselves then answer "not installed". */
  installed?: CommandContext["installed"];
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
/** Seconds between two tries of a command that waits for a port, and for a forge that is still computing. */
const WAIT_SECONDS = { portSeconds: 60, forgeSeconds: 30 };
const ALL_INSTALLED: CommandContext["installed"] = { forge: () => true, notifier: true, runtime: true };

/** `<repo>#<number>` for a PR; for another subject, the label of its last event, else `<kind>:<id>`. */
export function subjectLabelOf(store: Pick<OrchestratorStore, "ledger">, command: Pick<CommandRecord, "subjectKey">, record: PrRecord | null): string {
  if (record) return `${record.repo}#${record.number}`;
  for (const row of store.ledger(command.subjectKey).reverse()) {
    if (row.entry.type !== "event.received") continue;
    const { subject } = row.entry.event;
    return (subject as { label?: string }).label ?? `${subject.kind}:${"id" in subject ? subject.id : ""}`;
  }
  return command.subjectKey;
}

/** The merge commit of the latest pr.merged event of a PR, or "". */
function mergeShaOf(store: Pick<OrchestratorStore, "ledger">, command: Pick<CommandRecord, "subjectKey" | "type">): string {
  if (command.type !== "Notify") return "";
  for (const row of store.ledger(command.subjectKey).reverse()) {
    if (row.entry.type === "event.received" && row.entry.event.type === "pr.merged") {
      return (row.entry.event.data as { merge?: { commitSha?: string | null } }).merge?.commitSha ?? "";
    }
  }
  return "";
}

/** The config that a command reads: the repo's for a PR, the global one for another subject. */
export function configOfCommand(config: OrchestratorConfig, record: PrRecord | null) {
  return record ? resolveForRepo(config, record.provider, record.repo) : subjectConfig(config);
}

export function createCommandBus(deps: CommandBusDeps): CommandBus {
  const { store, pm } = deps;
  const running = new Set<Promise<void>>();

  async function call(handler: CommandHandler, command: CommandRecord, record: PrRecord | null, now: number): Promise<CommandResult | CommandWait> {
    try {
      const config = deps.config();
      return await handler(command, {
        record, config: configOfCommand(config, record), now, ports: deps.ports,
        bindOwner: owner => {
          if (record) pm.bindOwner(owner, { provider: record.provider, repo: record.repo, number: record.number, url: record.url });
        },
        installed: deps.installed ?? ALL_INSTALLED, subjectLabel: subjectLabelOf(store, command, record), mergeSha: mergeShaOf(store, command), wait: WAIT_SECONDS, log: deps.log,
      });
    } catch (error) {
      if (error instanceof NotInstalledError) return { outcome: "skipped", reason: "not installed" };
      if (error instanceof PortUnavailableError) return { outcome: "waiting", reason: error.message, retryAfterSeconds: WAIT_SECONDS.portSeconds };
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
    const attempts = command.attempts + 1;
    try {
      const { commands } = deps.config();
      if (result.outcome === "waiting") {
        if ((command.waits ?? 0) >= commands.maxWaits) pm.finishCommand(command, { outcome: "skipped", reason: `waited too long: ${result.reason}` });
        else store.rescheduleWait(command.id, deps.now() + result.retryAfterSeconds * MS, result.reason, deps.now());
      } else if (result.outcome === "failed" && result.retryable && attempts < commands.maxAttempts) {
        const seconds = Math.min(commands.backoffSeconds.initial * 2 ** (attempts - 1), commands.backoffSeconds.max);
        store.rescheduleCommand(command.id, deps.now() + seconds * MS, result.reason, deps.now());
      } else pm.finishCommand(command, result);
      deps.log(`pr-orchestrator: ${command.type} ${command.id} ${result.outcome} (attempt ${attempts})`);
    } catch (error) {
      deps.log(`pr-orchestrator: ${command.type} ${command.id} could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
      // Never leave the row running: that would hold every later command of the subject until a restart.
      settleRunning(command, result.outcome === "waiting" ? { outcome: "failed", reason: result.reason, retryable: false } : result);
    }
  }

  function settleRunning(command: CommandRecord, result: CommandResult): void {
    try {
      store.finishCommand(command.id, result, deps.now());
    } catch (error) {
      deps.log(`pr-orchestrator: ${command.type} ${command.id} stays running until a restart: ${error instanceof Error ? error.message : String(error)}`);
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
          const reason = error instanceof Error ? error.message : String(error);
          deps.log(`pr-orchestrator: ${command.type} ${command.id} failed to run: ${reason}`);
          settleRunning(command, { outcome: "failed", reason, retryable: false });
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
