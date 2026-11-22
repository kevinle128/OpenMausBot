import { existsSync } from "node:fs";
import { join } from "node:path";

import { vaultNameKey } from "../../shared/vault.ts";
import { createConfigSource, orchestratorActive } from "../pr-orchestrator/config.ts";
import { updateConnectorInstance } from "../pr-orchestrator/config-writer.ts";
import { connectorViewsIn, createOrchestratorCore, EMPTY_CONNECTOR_STATUS, inboundInstanceIn, routinesIn, type OrchestratorCore } from "../pr-orchestrator/core.ts";
import { BUILT_IN_CONNECTORS } from "../pr-orchestrator/connectors/index.ts";
import { createConnectorRegistry } from "../pr-orchestrator/connectors/registry.ts";
import { createEventsDoor } from "../pr-orchestrator/intake.ts";
import { createPrOrchestratorRoutes } from "../routes/pr-orchestrator.ts";
import type { RouteHandler } from "../routes/table.ts";
import { TEAM_READER, type VaultStore } from "../vault-store.ts";
import type { IngressDoor } from "../webhook-ingress.ts";

export interface PrOrchestratorHostDeps {
  dataDir: string;
  vault: Pick<VaultStore, "listSecrets" | "secret">;
  claimRequest?: () => () => void;
  /** The advertised base URL of the webhook listener. */
  webhookBase?: () => string;
  log?: (line: string) => void;
}

export interface PrOrchestratorHost {
  door: IngressDoor;
  routes: RouteHandler;
  start(): void;
  /** Closes pr-orchestrator.db and its WAL. Safe to call twice: the shutdown starts it and a later step awaits it, so the exit (and the data-dir lease) waits for the close. A backup flush calls it too so the copy holds a settled file; resume opens it again. */
  stop(): Promise<void>;
}

export function createPrOrchestratorHost(deps: PrOrchestratorHostDeps): PrOrchestratorHost {
  const dbPath = join(deps.dataDir, "pr-orchestrator.db");
  const configPath = join(deps.dataDir, "pr-orchestrator.json");
  const log = deps.log ?? (() => {});
  let core: OrchestratorCore | null = null;
  let running = false;
  let stopping: Promise<void> | null = null;

  // Security: the hub's key is read from the Vault for one check and dropped. It is never logged, cached,
  // returned by a route or sent to a bot. Only the team's secrets count, never a person's own.
  const key = (secretName: string): Buffer | null => {
    const wanted = vaultNameKey(secretName);
    const found = deps.vault.listSecrets(TEAM_READER).find(summary => vaultNameKey(summary.name) === wanted);
    const value = found ? deps.vault.secret(found.id)?.value : undefined;
    return value ? Buffer.from(value, "utf8") : null;
  };

  /** The core exists only once the feature has a file; an install that never uses it opens no database. */
  const ensureCore = (): OrchestratorCore | null => {
    if (core) return core;
    if (!running || stopping || !(existsSync(configPath) || existsSync(dbPath))) return null;
    core = createOrchestratorCore({ dbPath, configPath, connectors: BUILT_IN_CONNECTORS, key, log });
    core.start();
    return core;
  };

  // While no core is open (stopped for a backup or a shutdown, or a stop still closing), the door reads the file
  // without opening the database, so a configured connector answers 503 (retry) instead of 404 (no such endpoint).
  const registry = createConnectorRegistry(BUILT_IN_CONNECTORS);
  const fileConfig = createConfigSource({ path: () => configPath, connectors: BUILT_IN_CONNECTORS, log, onVersion: () => {} });
  const configOnFile = () => (existsSync(configPath) ? fileConfig.current().config : null);

  const door = createEventsDoor({
    enabled: () => {
      const current = ensureCore();
      return current ? current.enabled() : orchestratorActive(configOnFile() ?? { enabled: false, connectors: {} });
    },
    instance: id => {
      const current = ensureCore();
      if (current) return current.inboundInstance(id);
      const config = configOnFile();
      return config ? inboundInstanceIn(config, registry, id) : null;
    },
    key,
    sink: {
      accept(items, now) {
        const current = ensureCore();
        if (!current) throw new Error("The orchestrator is stopped");
        return current.intake.accept(items, now);
      },
    },
    log: entry => ensureCore()?.logConnector({ ...entry, at: Date.now() }),
    ...(deps.claimRequest ? { claimRequest: deps.claimRequest } : {}),
    logLine: log,
  });

  const routes = createPrOrchestratorRoutes({
    core: ensureCore,
    secretPresent: name => key(name) !== null,
    ...(deps.webhookBase ? { webhookBase: deps.webhookBase } : {}),
    idle: () => {
      const { config } = fileConfig.current();
      return {
        connectors: connectorViewsIn(config, registry, name => key(name) !== null, () => EMPTY_CONNECTOR_STATUS),
        routines: routinesIn(config, registry),
      };
    },
    updateConnector: (id, patch) => updateConnectorInstance(configPath, BUILT_IN_CONNECTORS, id, patch),
  });

  return {
    door,
    routes,
    start() {
      running = true;
      // A core still closing keeps the database: the next one opens once it has, in stop()'s finally.
      if (!stopping) ensureCore();
    },
    stop() {
      running = false;
      const current = core;
      core = null;
      if (!current) return stopping ?? Promise.resolve();
      const next: Promise<void> = (stopping ?? Promise.resolve()).then(() => current.stop()).finally(() => {
        if (stopping !== next) return;
        stopping = null;
        if (running) ensureCore();
      });
      stopping = next;
      return next;
    },
  };
}
