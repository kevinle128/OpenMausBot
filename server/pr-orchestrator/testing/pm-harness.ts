import { configVersion, parseOrchestratorConfig } from "../config.ts";
import { BUILT_IN_CONNECTORS } from "../connectors/index.ts";
import { createConnectorRegistry, type ContractView } from "../connectors/registry.ts";
import { createProcessManager, type ProcessManager } from "../process-manager.ts";
import type { ConnectorDefinition } from "../ports.ts";
import { openOrchestratorStore, type OrchestratorStore } from "../store.ts";
import type {
  CommandRecord, CommandResult, CommandType, LedgerEntry, OmbEvent, OrchestratorConfig, PrKey, PrRecord, PrState,
} from "../types.ts";
import { counterIds, DEFAULT_PR_KEY, fakeClock, SHA_A, SHA_B } from "./builders.ts";

export const SKIPPED: CommandResult = { outcome: "skipped", reason: "not installed" };
export const FORGE_B = { headSha: SHA_B, mergeable: true, blockers: [], requiredChecks: null, baseFailing: [], failedJobs: [] };
export const FORGE_A = { ...FORGE_B, headSha: SHA_A };

export interface Harness {
  store: OrchestratorStore;
  pm: ProcessManager;
  clock: ReturnType<typeof fakeClock>;
  logs: string[];
  works: number;
  setConfig(doc: Record<string, unknown>): void;
  failConfigOnce(message: string): void;
  send(...events: OmbEvent[]): void;
  record(key?: PrKey): PrRecord;
  ledger(key?: PrKey): LedgerEntry[];
  states(key?: PrKey): PrState[];
  commands(type?: CommandType, key?: PrKey): CommandRecord[];
  finish(command: CommandRecord, result: CommandResult): void;
  settleSkipped(key?: PrKey): void;
  entries<T extends LedgerEntry["type"]>(type: T, key?: PrKey): Array<Extract<LedgerEntry, { type: T }>>;
  close(): void;
}

export function makeHarness(initial: Record<string, unknown> = { enabled: true }, extra: readonly ConnectorDefinition[] = [], contract?: ContractView): Harness {
  const store = openOrchestratorStore(":memory:");
  const clock = fakeClock();
  const connectors = [...BUILT_IN_CONNECTORS, ...extra] as ConnectorDefinition[];
  const logs: string[] = [];
  let current: { config: OrchestratorConfig; version: string; error: string | null };
  let failure: string | null = null;
  const load = (doc: Record<string, unknown>) => {
    const parsed = parseOrchestratorConfig(JSON.stringify(doc), connectors);
    if (!parsed.ok) throw new Error(`test config is invalid: ${parsed.error}`);
    current = { config: parsed.config, version: configVersion(parsed.config), error: null };
  };
  load(initial);
  const h = { works: 0 };
  const pm = createProcessManager({
    store, connectors: createConnectorRegistry(connectors, contract),
    config: () => {
      if (failure !== null) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      return current;
    },
    now: clock.now, newId: counterIds("c"), log: line => logs.push(line), onWork: () => { h.works += 1; },
  });
  const harness: Harness = {
    store, pm, clock, logs,
    get works() { return h.works; },
    setConfig: load,
    failConfigOnce: (message) => { failure = message; },
    send(...events) {
      pm.accept(events.map(event => ({ event, raw: "{}" })), clock.now());
      pm.drain();
    },
    record: (key = DEFAULT_PR_KEY) => store.getPr(key) as PrRecord,
    ledger: (key = DEFAULT_PR_KEY) => store.ledger(key).map(row => row.entry),
    states: (key = DEFAULT_PR_KEY) => store.ledger(key).flatMap(row => (row.entry.type === "state.changed" ? [row.entry.to] : [])),
    commands: (type, key = DEFAULT_PR_KEY) => store.commandsFor(key).filter(command => type === undefined || command.type === type),
    finish: (command, result) => { pm.finishCommand(store.getCommand(command.id) as CommandRecord, result); },
    settleSkipped(key = DEFAULT_PR_KEY) {
      for (let pending = store.commandsFor(key).filter(c => c.status === "pending"); pending.length > 0; pending = store.commandsFor(key).filter(c => c.status === "pending")) {
        for (const command of pending) harness.finish(command, SKIPPED);
      }
    },
    entries: <T extends LedgerEntry["type"]>(type: T, key = DEFAULT_PR_KEY) =>
      store.ledger(key).map(row => row.entry).filter((entry): entry is Extract<LedgerEntry, { type: T }> => entry.type === type),
    close: () => store.close(),
  };
  return harness;
}
