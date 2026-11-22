// Read-only admin view of the PR orchestrator. The one POST is a dry run of a routine and changes nothing.
import { InvalidRoutineError } from "../pr-orchestrator/simulate.ts";
import type { OrchestratorCore } from "../pr-orchestrator/core.ts";
import { PR_STATES, type PrState } from "../pr-orchestrator/types.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PrOrchestratorRouteDeps {
  /** The running core, or null while the feature has no config file or the host is stopped. */
  core(): OrchestratorCore | null;
  secretPresent(secretName: string): boolean;
}

const PREFIX = "/api/pr-orchestrator/";
const PR_KEY = /^(github|gitlab):[^\s#]+#\d+$/;
const ROUTINE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RUNS = /^routines\/([^/]+)\/runs$/;
const LIST_LIMIT = 200;
const TEST_BODY_LIMIT = 64 * 1024;

const isState = (value: string): value is PrState => (PR_STATES as readonly string[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function createPrOrchestratorRoutes(deps: PrOrchestratorRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    if (!path.startsWith(PREFIX)) return PASS;
    const rest = path.slice(PREFIX.length);
    const runs = RUNS.exec(rest);
    const known = ["status", "prs", "pr", "config", "connectors", "routines"].includes(rest) || runs !== null || rest === "routines/test";
    if (!known) return PASS;
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "The PR orchestrator needs the admin scope" });

    const post = rest === "routines/test";
    if (method !== (post ? "POST" : "GET")) return json(res, 405, { error: post ? "Use POST" : "Use GET" });

    const core = deps.core();
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
    if (rest === "connectors") return json(res, 200, { connectors: core.connectors(deps.secretPresent) });
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
