// Admin view of the PR orchestrator. The POST is a dry run of a routine and changes nothing; the one write is a connector's switch, settings and secret name.
import { InvalidRoutineError } from "../pr-orchestrator/simulate.ts";
import type { ConnectorWrite, ConnectorPatch } from "../pr-orchestrator/config-writer.ts";
import type { ConnectorView, OrchestratorCore } from "../pr-orchestrator/core.ts";
import { PR_STATES, type PrState } from "../pr-orchestrator/types.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PrOrchestratorRouteDeps {
  /** The running core, or null while the feature has no config file or the host is stopped. */
  core(): OrchestratorCore | null;
  secretPresent(secretName: string): boolean;
  /** The advertised base URL of the webhook listener; the connectors' intake URLs are built on it. */
  webhookBase?(): string;
  /** The connectors and routines a config file with no content would give, listed with no store, so the App section works before the first write. */
  idle?(): { connectors: ConnectorView[]; routines: ReturnType<OrchestratorCore["routines"]> };
  /** Writes one connector instance to the config file. */
  updateConnector(id: string, patch: ConnectorPatch): ConnectorWrite;
}

const PREFIX = "/api/pr-orchestrator/";
const PR_KEY = /^(github|gitlab):[^\s#]+#\d+$/;
const ROUTINE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RUNS = /^routines\/([^/]+)\/runs$/;
const LIST_LIMIT = 200;
const TEST_BODY_LIMIT = 64 * 1024;
const CONNECTOR_BODY_LIMIT = 16 * 1024;
const CONNECTOR_PATH = /^connectors\/([^/]+)$/;
const CONNECTOR_KEYS = ["enabled", "settings", "secretName"];

const isState = (value: string): value is PrState => (PR_STATES as readonly string[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The connectors as the App section lists them: with the URL a sender posts to, and the routines that listen to each instance. */
function connectorViews(views: ConnectorView[], routines: ReturnType<OrchestratorCore["routines"]>, deps: PrOrchestratorRouteDeps) {
  const base = deps.webhookBase?.().replace(/\/+$/, "");
  return views.map((view: ConnectorView) => {
    const types = new Set(view.eventTypes.map(item => item.type));
    const usedBy = routines
      .filter(routine => routine.when.on.some(name => name === "*" || types.has(name))
        && (!routine.when.connectors?.length || routine.when.connectors.includes(view.id)))
      .map(routine => ({ routineId: routine.id, name: routine.name, active: routine.active, describe: routine.describe }));
    return { ...view, intakeUrl: base && view.intakePath ? base + view.intakePath : null, usedBy };
  });
}

export function createPrOrchestratorRoutes(deps: PrOrchestratorRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    if (!path.startsWith(PREFIX)) return PASS;
    const rest = path.slice(PREFIX.length);
    const runs = RUNS.exec(rest);
    const connector = CONNECTOR_PATH.exec(rest);
    const known = ["status", "prs", "pr", "config", "connectors", "routines"].includes(rest) || runs !== null || rest === "routines/test" || connector !== null;
    if (!known) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "The PR orchestrator needs the admin scope" });

    if (connector) {
      if (method !== "PUT") return json(res, 405, { error: "Use PUT" });
      const id = connector[1]!;
      const body: unknown = await readBody(req, CONNECTOR_BODY_LIMIT);
      if (!isRecord(body)) return json(res, 400, { error: "Send a JSON object" });
      const unknownKey = Object.keys(body).find(key => !CONNECTOR_KEYS.includes(key));
      if (unknownKey) return json(res, 400, { error: `${unknownKey} is not a connector field; send enabled, settings or secretName` });
      const { enabled, settings, secretName } = body;
      if (enabled !== undefined && typeof enabled !== "boolean") return json(res, 400, { error: "enabled must be true or false" });
      if (settings !== undefined && !isRecord(settings)) return json(res, 400, { error: "settings must be a JSON object" });
      if (secretName !== undefined && typeof secretName !== "string") return json(res, 400, { error: "secretName must be a string" });
      const written = deps.updateConnector(id, {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(settings !== undefined ? { settings: settings as NonNullable<ConnectorPatch["settings"]> } : {}),
        ...(secretName !== undefined ? { secretName } : {}),
      });
      if (!written.ok) return json(res, written.reason === "unknown" ? 404 : 400, { error: written.error });
      const current = deps.core();
      const view = current ? connectorViews(current.connectors(deps.secretPresent), current.routines(), deps).find(item => item.id === id) : undefined;
      return view ? json(res, 200, view) : json(res, 503, { error: "The orchestrator is stopped; the change is saved and applies when it starts" });
    }
    const post = rest === "routines/test";
    if (method !== (post ? "POST" : "GET")) return json(res, 405, { error: post ? "Use POST" : "Use GET" });

    const core = deps.core();
    if (rest === "connectors" && !core && deps.idle) {
      const idle = deps.idle();
      return json(res, 200, { connectors: connectorViews(idle.connectors, idle.routines, deps) });
    }
    if (rest === "status" && !core) return json(res, 200, { enabled: false, configured: false });
    if (!core) return json(res, 404, { error: "The PR orchestrator has no configuration file yet" });

    if (rest === "status") {
      const anySecret = core.connectors(deps.secretPresent).some(item => item.enabled && item.secretPresent);
      return json(res, 200, { configured: true, ...core.status(anySecret) });
    }
    if (rest === "prs") {
      const state = url.searchParams.get("state");
      if (state !== null && !isState(state)) return json(res, 400, { error: `state must be one of ${PR_STATES.join(", ")}` });
      return json(res, 200, { prs: core.listPrs({ ...(state ? { state } : {}), limit: LIST_LIMIT }) });
    }
    if (rest === "pr") {
      const key = url.searchParams.get("key") ?? "";
      if (!PR_KEY.test(key)) return json(res, 400, { error: "key must look like github:owner/repo#123 or gitlab:group/project#123" });
      const found = core.pr(key);
      return found ? json(res, 200, found) : json(res, 404, { error: "No such PR" });
    }
    if (rest === "config") return json(res, 200, core.config());
    if (rest === "connectors") return json(res, 200, { connectors: connectorViews(core.connectors(deps.secretPresent), core.routines(), deps) });
    if (rest === "routines") return json(res, 200, { routines: core.routines() });
    if (runs) {
      const id = runs[1]!;
      if (!ROUTINE_ID.test(id)) return json(res, 400, { error: "Not a routine id" });
      return json(res, 200, { runs: core.routineRuns(id) });
    }

    const body: unknown = await readBody(req, TEST_BODY_LIMIT);
    if (!isRecord(body)) return json(res, 400, { error: "Send a JSON object" });
    const { prKey, inputSeq, routine, routineId } = body;
    if (typeof prKey !== "string" || !PR_KEY.test(prKey)) return json(res, 400, { error: "prKey must look like github:owner/repo#123" });
    if (typeof inputSeq !== "number" || !Number.isInteger(inputSeq) || inputSeq < 1) return json(res, 400, { error: "inputSeq must be a ledger row number" });
    if ((routine === undefined) === (routineId === undefined)) return json(res, 400, { error: "Send one of routine or routineId" });
    if (routine !== undefined && !isRecord(routine)) return json(res, 400, { error: "routine must be a JSON object" });
    if (routineId !== undefined && (typeof routineId !== "string" || !ROUTINE_ID.test(routineId))) return json(res, 400, { error: "routineId is not a routine id" });
    if (!core.pr(prKey)) return json(res, 404, { error: "No such PR" });
    try {
      const result = await core.testRoutine({
        ...(routine !== undefined ? { routine } : {}),
        ...(typeof routineId === "string" ? { routineId } : {}),
        prKey, inputSeq,
      });
      return json(res, 200, result);
    } catch (error) {
      if (error instanceof InvalidRoutineError) return json(res, 400, { error: error.message });
      if (error instanceof RangeError) return json(res, 404, { error: error.message });
      throw error;
    }
  };
}
