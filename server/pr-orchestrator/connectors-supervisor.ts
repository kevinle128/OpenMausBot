import { orchestratorActive } from "./config.ts";
import type { ConnectorRegistry } from "./connectors/registry.ts";
import { conformItems } from "./intake.ts";
import type { ConnectorDefinition, SubscriptionContext } from "./ports.ts";
import type { OrchestratorStore } from "./store.ts";
import type { IntakeSink, OrchestratorConfig } from "./types.ts";
import type { createOmbEventValidator } from "./contract/validate.ts";

const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const REASONS_LOGGED = 3;

type Validator = Pick<ReturnType<typeof createOmbEventValidator>, "checkFor">;

export interface SupervisorDeps {
  store: OrchestratorStore;
  sink: IntakeSink;
  registry: ConnectorRegistry;
  config(): OrchestratorConfig;
  /** The Vault value of a secret; never logged. */
  key(secretName: string): Buffer | null;
  validator: Validator;
  now(): number;
  log(line: string): void;
  /** Waits before a restart; resolves early when the signal aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

export interface ConnectorSupervisor {
  /** Starts the instances that the config enables, restarts the ones whose settings changed and aborts the ones it disabled or removed. */
  sync(): void;
  running(): string[];
  /** Aborts every instance and waits for them to end. */
  stop(): Promise<void>;
}

interface Running { fingerprint: string; abort: AbortController; done: Promise<void> }

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createConnectorSupervisor(deps: SupervisorDeps): ConnectorSupervisor {
  const { store } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const instances = new Map<string, Running>();
  let stopped = false;
  /** Runs that sync() replaced and that are still unwinding; stop() waits for them before the store closes. */
  // Keyed by instance: a run re-enabled by a later sync() still waits for the aborted one to unwind.
  const draining = new Map<string, Promise<void>>();

  function emitter(id: string, definition: ConnectorDefinition) {
    return (events: unknown[]) => {
      const { accepted, rejected } = conformItems(events, id, definition, deps.validator);
      const at = deps.now();
      if (accepted.length > 0) {
        try {
          const result = deps.sink.accept(accepted, at);
          if (result.stored > 0) store.logConnector({ connector: id, at, outcome: "accepted", count: result.stored });
          if (result.duplicates > 0) store.logConnector({ connector: id, at, outcome: "duplicate", count: result.duplicates });
        } catch (error) {
          deps.log(`pr-orchestrator: ${id}: the store could not take events (${messageOf(error)})`);
          store.logConnector({ connector: id, at, outcome: "error", count: accepted.length, detail: "the store could not take the events" });
        }
      }
      if (rejected.length > 0) {
        const detail = [...new Set(rejected.map(item => item.reason))].slice(0, REASONS_LOGGED).join("; ");
        store.logConnector({ connector: id, at, outcome: "rejected", count: rejected.length, detail });
      }
    };
  }

  async function loop(id: string, definition: ConnectorDefinition, signal: AbortSignal, previous?: Promise<void>): Promise<void> {
    // A replaced run of the same instance unwinds first: two runs would race on its cursor.
    if (previous) await previous;
    let delay = BACKOFF_INITIAL_MS;
    while (!signal.aborted) {
      const startedAt = deps.now();
      let reason: string;
      try {
        const instance = deps.config().connectors[id];
        if (!instance) return;
        const secretName = instance.secretName ?? (definition.secret.defaultName || null);
        const key = secretName ? deps.key(secretName) : null;
        if (definition.secret.required && !key) throw new Error("the connector's secret is not in the Vault");
        const ctx: SubscriptionContext<unknown> = {
          instance: id,
          settings: definition.settingsSchema.parse(instance.settings ?? {}),
          key,
          signal,
          now: deps.now,
          emit: emitter(id, definition),
          cursor: () => store.cursor(id)?.cursor ?? null,
          saveCursor: cursor => store.saveCursor(id, cursor, deps.now()),
          report: health => {
            if (!health.ok) store.logConnector({ connector: id, at: deps.now(), outcome: "error", count: 1, detail: health.detail ?? "the connector reports a problem" });
          },
        };
        await definition.subscribe!(ctx);
        reason = "the subscription ended";
      } catch (error) {
        reason = messageOf(error);
      }
      if (signal.aborted) return;
      if (deps.now() - startedAt >= BACKOFF_MAX_MS) delay = BACKOFF_INITIAL_MS;
      store.logConnector({ connector: id, at: deps.now(), outcome: "error", count: 1, detail: reason });
      deps.log(`pr-orchestrator: ${id} stopped (${reason}); restarting in ${delay / 1000} s`);
      await sleep(delay, signal);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }

  function desired(): Map<string, { definition: ConnectorDefinition; fingerprint: string }> {
    const config = deps.config();
    const wanted = new Map<string, { definition: ConnectorDefinition; fingerprint: string }>();
    if (!orchestratorActive(config)) return wanted;
    for (const [id, instance] of Object.entries(config.connectors)) {
      const definition = deps.registry.get(instance.use);
      if (!instance.enabled || !definition?.subscribe || definition.delivery === "inbound-http") continue;
      wanted.set(id, { definition, fingerprint: JSON.stringify([instance.use, instance.secretName ?? null, instance.settings]) });
    }
    return wanted;
  }

  return {
    sync() {
      if (stopped) return;
      const wanted = desired();
      for (const [id, running] of instances) {
        if (wanted.get(id)?.fingerprint === running.fingerprint) continue;
        running.abort.abort();
        instances.delete(id);
        // running.done already waited for any earlier run of this id, so it replaces that entry.
        draining.set(id, running.done);
        void running.done.finally(() => { if (draining.get(id) === running.done) draining.delete(id); });
      }
      for (const [id, { definition, fingerprint }] of wanted) {
        if (instances.has(id)) continue;
        const abort = new AbortController();
        const done = loop(id, definition, abort.signal, draining.get(id)).catch(error => deps.log(`pr-orchestrator: ${id} failed: ${messageOf(error)}`));
        instances.set(id, { fingerprint, abort, done });
      }
    },
    running: () => [...instances.keys()],
    async stop() {
      stopped = true;
      const all = [...instances.values()];
      for (const running of all) running.abort.abort();
      instances.clear();
      await Promise.all([...all.map(running => running.done), ...draining.values()]);
    },
  };
}
