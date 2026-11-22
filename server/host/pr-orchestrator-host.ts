import { existsSync } from "node:fs";
import { join } from "node:path";

import { vaultNameKey } from "../../shared/vault.ts";
import { buildAdapters, type AttachParts } from "../pr-orchestrator/adapters/build.ts";
import { noneAttached, type AttachedAdapters } from "../pr-orchestrator/adapters/switched.ts";
import { createConfigSource, orchestratorActive } from "../pr-orchestrator/config.ts";
import { updateConnectorInstance } from "../pr-orchestrator/config-writer.ts";
import type { Owner, SubjectKey } from "../pr-orchestrator/types.ts";
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
  /**
   * Hands over what the adapters need from the server (the Paseo connection, the Inbox parts). It works with no core: the
   * server calls it once at load, before the first core exists, and every core gets the adapters when it is made.
   * A second call is ignored. Which adapter a port uses is the person's switch in the config, read on every call.
   */
  attach(parts: AttachParts): void;
  /** Delivers a person's answer to the core that runs now; dropped (and logged) while no core runs. Never keep a core: the host makes a new one after each stop. */
  answer(subjectKey: SubjectKey, decisionId: string, answer: string): void;
  /** Binds a PR to an agent session on the core that runs now; dropped (and logged) while no core runs. */
  bindOwner(owner: Owner, pr: { provider: "github" | "gitlab"; repo: string; number: number; url: string | null }): void;
  /** Stops the adapters at shutdown. A move freeze stops and starts the core but keeps the attachment, so stop() never detaches. */
  detach(): void;
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

  // Security: a secret (the hub's key, a forge credential) is read from the Vault for one use and dropped. It is never
  // logged, cached, returned by a route or sent to a bot. Only the team's secrets count, never a person's own.
  const secret = (secretName: string): string | null => {
    const wanted = vaultNameKey(secretName);
    const found = deps.vault.listSecrets(TEAM_READER).find(summary => vaultNameKey(summary.name) === wanted);
    const value = found ? deps.vault.secret(found.id)?.value : undefined;
    return value || null;
  };
  const key = (secretName: string): Buffer | null => {
    const value = secret(secretName);
    return value ? Buffer.from(value, "utf8") : null;
  };
  let attached: (AttachedAdapters & { stop(): void }) | null = null;

  /** The core exists only once the feature has a file; an install that never uses it opens no database. */
  const ensureCore = (): OrchestratorCore | null => {
    if (core) return core;
    if (!running || stopping || !(existsSync(configPath) || existsSync(dbPath))) return null;
    core = createOrchestratorCore({ dbPath, configPath, connectors: BUILT_IN_CONNECTORS, key, log, attached: () => attached ?? noneAttached() });
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

  /** Runs a call on the core that runs now. The host makes a new core after each stop, so no caller may keep one. */
  const onCore = (what: string, call: (current: OrchestratorCore) => void): void => {
    const current = ensureCore();
    if (!current) {
      log(`pr-orchestrator: ${what} dropped, the orchestrator is stopped`);
      return;
    }
    try {
      call(current);
    } catch (error) {
      log(`pr-orchestrator: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    door,
    routes,
    attach(parts) {
      if (attached) {
        log("pr-orchestrator: adapters are already attached; the second attach is ignored");
        return;
      }
      attached = buildAdapters(parts, {
        log, now: Date.now, config: () => (core ? core.config().effective : fileConfig.current().config), secret,
        answer: (subjectKey, decisionId, answer) => onCore("answer", current => { current.inputs.answer(subjectKey, decisionId, answer); }),
      });
      core?.resumeCards();
    },
    answer: (subjectKey, decisionId, answer) => onCore("answer", current => { current.inputs.answer(subjectKey, decisionId, answer); }),
    bindOwner: (owner, pr) => onCore("owner binding", current => { current.inputs.bindOwner(owner, pr); }),
    detach() {
      const current = attached;
      attached = null;
      current?.stop();
    },
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
