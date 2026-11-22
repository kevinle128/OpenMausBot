import { randomUUID } from "node:crypto";
import { z } from "zod";
import { startDueTimer } from "../due-timer.ts";
import { createCommandBus, type CommandBus } from "./command-bus.ts";
import { configJsonSchema, createConfigSource, resolveRoutines } from "./config.ts";
import { createConnectorSupervisor, type ConnectorSupervisor } from "./connectors-supervisor.ts";
import { BUILT_IN_CONNECTORS } from "./connectors/index.ts";
import { createConnectorRegistry, type ConnectorEventType, type ConnectorRegistry } from "./connectors/registry.ts";
import { createOmbEventValidator } from "./contract/validate.ts";
import { stubPorts } from "./adapters/stub.ts";
import { stubHandlers, type CommandHandlers, type OrchestratorPorts } from "./handlers.ts";
import type { ConnectorDefinition } from "./ports.ts";
import { createProcessManager, type EvaluationInfo, type ProcessManager } from "./process-manager.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { describeRoutineWith, testRoutine as runRoutineTest, toSimInputs, type RoutineTestResult } from "./simulate.ts";
import { openOrchestratorStore, type OrchestratorStore, type ReceivedStatus } from "./store.ts";
import {
  ROUTINE_HISTORY_SHOWN,
  type CommandRecord, type IntakeSink, type LedgerRow, type OrchestratorConfig, type PrKey, type PrRecord, type PrState,
  type Routine, type TimerRecord, type TriggerName,
} from "./types.ts";

const SYNC_INTERVAL_MS = 15_000;
const STOP_WAIT_MS = 5_000;
const LIST_LIMIT = 200;

export interface LoadedConfig { config: OrchestratorConfig; version: string; error: string | null }

export interface CoreParts { store: OrchestratorStore; pm: ProcessManager; bus: CommandBus; scheduler: Scheduler; ports: OrchestratorPorts }

export interface CoreDeps {
  store: OrchestratorStore;
  connectors: ConnectorRegistry;
  config(): LoadedConfig;
  now(): number;
  newId(): string;
  handlers?: Partial<CommandHandlers>;
  ports?: Partial<OrchestratorPorts>;
  startTimer?: typeof startDueTimer;
  onEvaluate?(info: EvaluationInfo): void;
  log(line: string): void;
}

/** The parts that run steps: the process manager, the command bus and the scheduler, wired so that new work pokes the scheduler. */
export function createCoreParts(deps: CoreDeps): CoreParts {
  const ports: OrchestratorPorts = { ...stubPorts(), ...deps.ports };
  const handlers: CommandHandlers = { ...stubHandlers(), ...deps.handlers };
  let scheduler: Scheduler | null = null;
  const poke = () => scheduler?.poke();
  const pm = createProcessManager({
    store: deps.store, connectors: deps.connectors, config: deps.config, now: deps.now, newId: deps.newId, log: deps.log, onWork: poke,
    ...(deps.onEvaluate ? { onEvaluate: deps.onEvaluate } : {}),
  });
  const config = () => deps.config().config;
  const bus = createCommandBus({ store: deps.store, pm, handlers, ports, config, now: deps.now, log: deps.log, onSettled: poke });
  scheduler = createScheduler({ store: deps.store, pm, bus, now: deps.now, config, startTimer: deps.startTimer, log: deps.log });
  return { store: deps.store, pm, bus, scheduler, ports };
}

export interface CoreStatus {
  enabled: boolean; configVersion: string; configError: string | null; secretPresent: boolean;
  counts: {
    byState: Partial<Record<PrState, number>>; receivedByStatus: Record<ReceivedStatus, number>;
    commands: Array<{ status: string; outcome: string | null; count: number }>; timersArmed: number;
  };
  lastReceivedAt: number | null;
}

export interface ConnectorView {
  id: string; use: string; title: string; description: string; icon: ConnectorDefinition["icon"]; delivery: ConnectorDefinition["delivery"];
  enabled: boolean; intakePath: string | null; secretName: string | null; secretPresent: boolean;
  settings: unknown; settingsSchema: Record<string, unknown>; eventTypes: ConnectorEventType[];
  status: ReturnType<OrchestratorStore["connectorStatus"]> & { cursorUpdatedAt: number | null };
}

export interface RoutineRun {
  prKey: PrKey; at: number; trigger: TriggerName;
  actions: Array<{ action: string; result: string; commandId?: string; status?: string; outcome?: string | null; reason?: string }>;
}

export interface OrchestratorCore {
  intake: IntakeSink;
  enabled(): boolean;
  /** Repairs the projection, puts interrupted commands back in the queue, listens to workflow runs and starts the connectors. Call it once, in the tick that created the core. */
  start(): void;
  /** Stops the timers and the connectors, waits at most 5 s for running commands, and closes the store. A second call returns the same promise. */
  stop(): Promise<void>;
  status(secretPresent: boolean): CoreStatus;
  /** Each configured instance for the App section and the routine editor. */
  connectors(secretPresent: (secretName: string) => boolean): ConnectorView[];
  /** For the door: an enabled inbound instance, or null. */
  inboundInstance(id: string): { definition: ConnectorDefinition; settings: unknown; secretName: string | null } | null;
  logConnector: OrchestratorStore["logConnector"];
  listPrs(filter: { state?: PrState; limit: number }): PrRecord[];
  pr(key: PrKey): { record: PrRecord; ledger: LedgerRow[]; commands: CommandRecord[]; timers: TimerRecord[] } | null;
  config(): { effective: OrchestratorConfig; version: string; error: string | null; schema: Record<string, unknown> };
  inputs: Pick<ProcessManager, "bindOwner" | "answer" | "runFinished">;
  /** Resolved routines with their sentence ("When to run") and source. */
  routines(): Array<Routine & { source: "default" | "custom"; describe: string }>;
  /** The last ROUTINE_HISTORY_SHOWN runs of one routine, each action with its command's current status and outcome. */
  routineRuns(routineId: string): RoutineRun[];
  /** Dry run of one routine on one stored input of a PR; touches no table of the live store. Throws InvalidRoutineError for a draft that the config schema refuses. */
  testRoutine(req: { routine?: object; routineId?: string; prKey: PrKey; inputSeq: number }): Promise<RoutineTestResult>;
  verifyProjection(): PrKey[];
  reprocess(status: "failed"): number;
}

export interface CoreOptions {
  dbPath: string;
  configPath: string;
  connectors?: readonly ConnectorDefinition[];
  /** The Vault value of a secret by name; null when it is not saved. */
  key?: (secretName: string) => Buffer | null;
  now?: () => number;
  newId?: () => string;
  handlers?: Partial<CommandHandlers>;
  ports?: Partial<OrchestratorPorts>;
  startTimer?: typeof startDueTimer;
  log?: (line: string) => void;
}

const withoutSource = ({ source: _source, ...routine }: Routine & { source: string }): Routine => routine;

const secretNameOf = (instance: { secretName?: string }, definition: ConnectorDefinition): string | null =>
  instance.secretName ?? (definition.secret.defaultName || null);

/** An enabled inbound-http instance of a config, or null. */
export function inboundInstanceIn(
  config: OrchestratorConfig, registry: ConnectorRegistry, id: string,
): { definition: ConnectorDefinition; settings: unknown; secretName: string | null } | null {
  const instance = config.connectors[id];
  const definition = instance ? registry.get(instance.use) : undefined;
  if (!instance || !definition || !instance.enabled || definition.delivery !== "inbound-http") return null;
  return { definition, settings: instance.settings, secretName: secretNameOf(instance, definition) };
}

export function createOrchestratorCore(deps: CoreOptions): OrchestratorCore {
  const definitions = (deps.connectors ?? BUILT_IN_CONNECTORS) as readonly ConnectorDefinition[];
  const registry = createConnectorRegistry(definitions);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const key = deps.key ?? (() => null);
  const store = openOrchestratorStore(deps.dbPath);
  const source = createConfigSource({
    path: () => deps.configPath, connectors: definitions, log,
    onVersion: version => log(`pr-orchestrator: config ${version.slice(0, 12)}`),
  });
  const loaded = () => source.current();
  const parts = createCoreParts({
    store, connectors: registry, config: loaded, now, newId: deps.newId ?? randomUUID, handlers: deps.handlers, ports: deps.ports,
    startTimer: deps.startTimer, log,
  });
  const supervisor: ConnectorSupervisor = createConnectorSupervisor({
    store, sink: parts.pm, registry, config: () => loaded().config, key, validator: createOmbEventValidator(), now, log,
  });
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let unwatch: (() => void) | null = null;
  let stopping: Promise<void> | null = null;
  let schema: Record<string, unknown> | null = null;

  function onWorkflowDone(done: { runRef: string; outcome: "completed" | "failed" | "cancelled" }): void {
    const command = store.commandByRunRef(done.runRef);
    if (!command || command.payload.type !== "RunWorkflow") {
      log("pr-orchestrator: a workflow run ended that no command started");
      return;
    }
    try {
      parts.pm.runFinished(command.subjectKey, { target: command.payload.guard, runRef: done.runRef, outcome: done.outcome });
    } catch (error) {
      log(`pr-orchestrator: run ${done.runRef} could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    intake: parts.pm,
    enabled: () => loaded().config.enabled,

    start() {
      parts.pm.ensureProjectionVersion();
      store.resetRunningCommands(now());
      unwatch = parts.ports.workflows.watch(onWorkflowDone);
      supervisor.sync();
      parts.scheduler.start();
      syncTimer = setInterval(() => supervisor.sync(), SYNC_INTERVAL_MS);
      syncTimer.unref?.();
    },

    stop() {
      stopping ??= (async () => {
        if (syncTimer) clearInterval(syncTimer);
        unwatch?.();
        parts.scheduler.stop();
        await supervisor.stop();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([parts.bus.idle(), new Promise<void>(resolve => { timeout = setTimeout(resolve, STOP_WAIT_MS); })]);
        clearTimeout(timeout);
        store.close();
      })();
      return stopping;
    },

    status(secretPresent) {
      const { config, version, error } = loaded();
      return {
        enabled: config.enabled, configVersion: version, configError: error, secretPresent,
        counts: {
          byState: store.countPrsByState(), receivedByStatus: store.countReceivedByStatus(), commands: store.countCommands(),
          timersArmed: store.countArmedTimers(),
        },
        lastReceivedAt: store.lastReceivedAt(),
      };
    },

    connectors(secretPresent) {
      const at = now();
      return Object.entries(loaded().config.connectors).flatMap(([id, instance]) => {
        const definition = registry.get(instance.use);
        if (!definition) return [];
        const secretName = secretNameOf(instance, definition);
        return [{
          id, use: instance.use, title: definition.title, description: definition.description, icon: definition.icon, delivery: definition.delivery,
          enabled: instance.enabled, intakePath: definition.delivery === "inbound-http" ? `/events/${id}` : null,
          secretName, secretPresent: secretName !== null && secretPresent(secretName),
          settings: instance.settings, settingsSchema: z.toJSONSchema(definition.settingsSchema, { io: "input" }) as Record<string, unknown>,
          eventTypes: registry.eventTypes(instance.use),
          status: { ...store.connectorStatus(id, at), cursorUpdatedAt: store.cursor(id)?.updatedAt ?? null },
        }];
      });
    },

    inboundInstance: id => inboundInstanceIn(loaded().config, registry, id),

    logConnector: entry => store.logConnector(entry),
    listPrs: filter => store.listPrs({ ...filter, limit: Math.min(filter.limit, LIST_LIMIT) }),

    pr(prKey) {
      const record = store.getPr(prKey);
      return record ? { record, ledger: store.ledger(prKey), commands: store.commandsFor(prKey), timers: store.timersFor(prKey) } : null;
    },

    config() {
      const { config, version, error } = loaded();
      schema ??= configJsonSchema(definitions);
      return { effective: config, version, error, schema };
    },

    inputs: { bindOwner: parts.pm.bindOwner, answer: parts.pm.answer, runFinished: parts.pm.runFinished },

    routines() {
      const { config } = loaded();
      return resolveRoutines(config).map(routine => ({ ...routine, describe: describeRoutineWith(routine, registry, config) }));
    },

    routineRuns(routineId) {
      return store.routineRuns(routineId, ROUTINE_HISTORY_SHOWN).flatMap((row): RoutineRun[] => {
        if (row.entry.type !== "routine.matched") return [];
        return [{
          prKey: row.subjectKey, at: row.at, trigger: row.entry.trigger,
          actions: row.entry.actions.map(line => {
            const command = line.commandId ? store.getCommand(line.commandId) : null;
            // A finished command's reason is its result's; lastError keeps an earlier attempt's error after a success.
            const commandReason = command?.result
              ? (command.result.outcome === "succeeded" ? undefined : command.result.reason)
              : (command?.lastError ?? undefined);
            const reason = line.reason ?? commandReason;
            return {
              action: line.action, result: line.result,
              ...(line.commandId ? { commandId: line.commandId } : {}),
              ...(command ? { status: command.status, outcome: command.outcome } : {}),
              ...(reason ? { reason } : {}),
            };
          }),
        }];
      });
    },

    async testRoutine(req) {
      const { config } = loaded();
      const resolved = resolveRoutines(config).find(candidate => candidate.id === req.routineId);
      const routine = req.routine ?? (resolved ? withoutSource(resolved) : undefined);
      if (!routine) throw new RangeError(`unknown routine ${req.routineId ?? ""}`);
      const rows = store.ledger(req.prKey).filter(row => row.causationSeq === null && row.seq <= req.inputSeq);
      if (rows.at(-1)?.seq !== req.inputSeq) throw new RangeError(`ledger row ${req.inputSeq} of ${req.prKey} is not an input`);
      return runRoutineTest({ config, inputs: toSimInputs(rows), routine, inputIndex: rows.length - 1, registry });
    },

    verifyProjection: () => parts.pm.verifyProjection(),
    reprocess: status => parts.pm.reprocess(status),
  };
}
