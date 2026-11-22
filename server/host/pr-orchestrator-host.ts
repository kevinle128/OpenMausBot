import { existsSync } from "node:fs";
import { join } from "node:path";

import { vaultNameKey } from "../../shared/vault.ts";
import { createOrchestratorCore, type OrchestratorCore } from "../pr-orchestrator/core.ts";
import { BUILT_IN_CONNECTORS } from "../pr-orchestrator/connectors/index.ts";
import { createEventsDoor } from "../pr-orchestrator/intake.ts";
import { createPrOrchestratorRoutes } from "../routes/pr-orchestrator.ts";
import type { RouteHandler } from "../routes/table.ts";
import { TEAM_READER, type VaultStore } from "../vault-store.ts";
import type { IngressDoor } from "../webhook-ingress.ts";

export interface PrOrchestratorHostDeps {
  dataDir: string;
  vault: Pick<VaultStore, "listSecrets" | "secret">;
  claimRequest?: () => () => void;
  log?: (line: string) => void;
}

export interface PrOrchestratorHost {
  door: IngressDoor;
  routes: RouteHandler;
  start(): void;
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
    if (!running || !(existsSync(configPath) || existsSync(dbPath))) return null;
    core = createOrchestratorCore({ dbPath, configPath, connectors: BUILT_IN_CONNECTORS, key, log });
    core.start();
    return core;
  };

  const door = createEventsDoor({
    enabled: () => ensureCore()?.enabled() ?? false,
    instance: id => ensureCore()?.inboundInstance(id) ?? null,
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
  });

  return {
    door,
    routes,
    start() {
      running = true;
      stopping = null;
      ensureCore();
    },
    stop() {
      running = false;
      if (stopping) return stopping;
      const current = core;
      core = null;
      if (!current) return Promise.resolve();
      stopping = current.stop();
      return stopping;
    },
  };
}
