// Unified Forge Apps (GitHub / self-hosted GitLab) + reusable Resource Picker route.
import {
  connectForgeApp,
  disconnectForgeApp,
  ForgeError,
  forgeIdOfApp,
  isForgeId,
  listForgeApps,
  listForgeRepositories,
  type ForgeId,
} from "../apps/forge-connections.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ForgeAppsRouteDeps {
  storePath: string;
  /** Recent repository names already observed by the orchestrator for a forge. */
  recentRepos?: (forge: ForgeId) => string[];
  fetchImpl?: typeof fetch;
}

const FORGE_LIST = "/api/apps/forge";
const FORGE_ONE = /^\/api\/apps\/forge\/([a-z0-9-]+)$/;
const APP_RESOURCES = /^\/api\/apps\/([a-z0-9-]+)\/resources$/;
const BODY_LIMIT = 16 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createForgeAppsRoutes(deps: ForgeAppsRouteDeps): RouteHandler {
  return async ({ req, res, path, method, url, auth, json, readBody }) => {
    const forgeOne = FORGE_ONE.exec(path);
    const resources = APP_RESOURCES.exec(path);
    if (path !== FORGE_LIST && !forgeOne && !resources) return PASS;

    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "This action needs the admin scope" });
    res.setHeader("cache-control", "no-store");

    if (path === FORGE_LIST) {
      if (method !== "GET") return json(res, 405, { error: "Use GET" });
      return json(res, 200, { apps: listForgeApps(deps.storePath) });
    }

    if (forgeOne) {
      const id = forgeOne[1]!;
      if (!isForgeId(id)) return json(res, 404, { error: `Unknown forge app: ${id}` });
      if (method === "DELETE") return json(res, 200, disconnectForgeApp(deps.storePath, id));
      if (method !== "PUT") return json(res, 405, { error: "Use PUT or DELETE" });
      const body: unknown = await readBody(req, BODY_LIMIT);
      if (!isRecord(body) || typeof body.token !== "string") {
        return json(res, 400, { error: "Send a JSON object with token" });
      }
      if (body.baseUrl !== undefined && typeof body.baseUrl !== "string") {
        return json(res, 400, { error: "baseUrl must be a string" });
      }
      try {
        const view = await connectForgeApp(
          deps.storePath,
          id,
          { token: body.token, ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}) },
          deps.fetchImpl,
        );
        return json(res, 200, view);
      } catch (err) {
        if (err instanceof ForgeError) return json(res, err.status, { error: err.message });
        throw err;
      }
    }

    // GET /api/apps/:slug/resources?kind=repositories&q=...
    if (method !== "GET") return json(res, 405, { error: "Use GET" });
    const slug = resources![1]!;
    const kind = url.searchParams.get("kind") ?? "repositories";
    if (kind !== "repositories") return json(res, 200, { items: [] });
    const forge = forgeIdOfApp(slug);
    if (!forge) return json(res, 200, { items: [] });
    const query = url.searchParams.get("q") ?? "";
    const recent = deps.recentRepos?.(forge) ?? [];
    const items = await listForgeRepositories(deps.storePath, forge, { query, recentRepos: recent, fetchImpl: deps.fetchImpl });
    return json(res, 200, { items });
  };
}
