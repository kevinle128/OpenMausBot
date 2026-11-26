// Unified native GitHub & GitLab (self-hosted) connections + reusable repository resource listing.
// Tokens are stored write-only in forge-apps.json (mode 0600) and never returned by any route.
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic.ts";
import { parseJson } from "../schema.ts";

export type ForgeId = "github" | "gitlab";

export interface ForgeAppView {
  id: ForgeId;
  title: string;
  description: string;
  baseUrl: string;
  connected: boolean;
  login: string | null;
}

export interface ResourceItem {
  id: string;
  label: string;
  meta?: string;
  group: "wildcard" | "recent" | "all";
}

interface StoredForge {
  token: string;
  baseUrl: string;
  login?: string;
}

type StoredMap = Partial<Record<ForgeId, StoredForge>>;

export const DEFAULT_GITHUB_API = "https://api.github.com";
export const DEFAULT_GITLAB_URL = "https://git.oceanlabs.dev";
const CACHE_TTL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const META: Record<ForgeId, { title: string; description: string; defaultUrl: string }> = {
  github: {
    title: "GitHub",
    description: "Pull requests, repositories, and automated workflows.",
    defaultUrl: DEFAULT_GITHUB_API,
  },
  gitlab: {
    title: "GitLab",
    description: "Self-hosted GitLab projects, merge requests, and CI events.",
    defaultUrl: DEFAULT_GITLAB_URL,
  },
};

export function isForgeId(value: string): value is ForgeId {
  return value === "github" || value === "gitlab";
}

export function forgeIdOfApp(slug: string): ForgeId | null {
  const s = slug.trim().toLowerCase();
  if (s === "github" || s === "github-event") return "github";
  if (s === "gitlab" || s === "gitlab-event") return "gitlab";
  return null;
}

/** Validates https URLs (or http on loopback for tests); strips trailing slashes and forbids embedded credentials. */
export function normalizeForgeUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ForgeError(400, "Server URL must be a valid https:// address");
  }
  if (parsed.username || parsed.password) throw new ForgeError(400, "Server URL must not include credentials");
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new ForgeError(400, "Server URL must use https://");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export class ForgeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readStore(path: string): StoredMap {
  try {
    const raw: unknown = parseJson(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: StoredMap = {};
    for (const id of ["github", "gitlab"] as const) {
      const entry = (raw as Record<string, unknown>)[id];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const rec = entry as Record<string, unknown>;
      if (typeof rec.token === "string" && rec.token.length > 0) {
        out[id] = {
          token: rec.token,
          baseUrl: typeof rec.baseUrl === "string" && rec.baseUrl ? rec.baseUrl : META[id].defaultUrl,
          ...(typeof rec.login === "string" && rec.login ? { login: rec.login } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(path: string, map: StoredMap): void {
  writeFileAtomic(path, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
}

const repoCache = new Map<string, { at: number; repos: string[] }>();

export function clearForgeRepoCache(path?: string, id?: ForgeId): void {
  if (!path) {
    repoCache.clear();
    return;
  }
  if (id) repoCache.delete(`${path}:${id}`);
  else {
    repoCache.delete(`${path}:github`);
    repoCache.delete(`${path}:gitlab`);
  }
}

export function listForgeApps(path: string): ForgeAppView[] {
  const store = readStore(path);
  return (["github", "gitlab"] as const).map((id) => {
    const saved = store[id];
    return {
      id,
      title: META[id].title,
      description: META[id].description,
      baseUrl: saved?.baseUrl ?? META[id].defaultUrl,
      connected: Boolean(saved?.token),
      login: saved?.login ?? null,
    };
  });
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
  } catch (err) {
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    throw new ForgeError(502, `Could not reach ${host}: ${err instanceof Error ? err.message : "network error"}`);
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(id: ForgeId, token: string): Record<string, string> {
  return id === "github"
    ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "OpenMausBot" }
    : { "PRIVATE-TOKEN": token, Accept: "application/json", "User-Agent": "OpenMausBot" };
}

export async function connectForgeApp(
  path: string,
  id: ForgeId,
  input: { token: string; baseUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ForgeAppView> {
  const token = input.token.trim();
  if (!token || /\s/.test(token)) throw new ForgeError(400, "Personal Access Token must not be empty or contain spaces");
  const baseUrl = input.baseUrl?.trim() ? normalizeForgeUrl(input.baseUrl) : META[id].defaultUrl;
  const checkUrl = id === "github" ? `${baseUrl}/user` : `${baseUrl}/api/v4/user`;
  const { status, body } = await fetchJson(fetchImpl, checkUrl, authHeaders(id, token));
  if (status === 401 || status === 403) {
    throw new ForgeError(400, id === "github"
      ? "GitHub rejected this Personal Access Token. Check that it is valid and not expired."
      : "GitLab rejected this Personal Access Token. Check that it has read_api or api scope.");
  }
  if (status < 200 || status >= 300 || !body || typeof body !== "object") {
    throw new ForgeError(502, `${META[id].title} returned HTTP ${status}`);
  }
  const rec = body as Record<string, unknown>;
  const login = typeof rec.login === "string" ? rec.login : typeof rec.username === "string" ? rec.username : undefined;
  const store = readStore(path);
  store[id] = { token, baseUrl, ...(login ? { login } : {}) };
  writeStore(path, store);
  clearForgeRepoCache(path, id);
  return listForgeApps(path).find((item) => item.id === id)!;
}

export function disconnectForgeApp(path: string, id: ForgeId): ForgeAppView {
  const store = readStore(path);
  delete store[id];
  writeStore(path, store);
  clearForgeRepoCache(path, id);
  return listForgeApps(path).find((item) => item.id === id)!;
}

async function fetchRemoteRepos(
  id: ForgeId,
  saved: StoredForge,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const url = id === "github"
    ? `${saved.baseUrl}/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member`
    : `${saved.baseUrl}/api/v4/projects?membership=true&simple=true&order_by=last_activity_at&per_page=100`;
  const { status, body } = await fetchJson(fetchImpl, url, authHeaders(id, saved.token));
  if (status < 200 || status >= 300 || !Array.isArray(body)) return [];
  const names: string[] = [];
  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const name = id === "github" ? rec.full_name : rec.path_with_namespace;
    if (typeof name === "string" && name.trim()) names.push(name.trim());
  }
  return names;
}

/**
 * Lists repository resources for a connected forge app, merging recent DB-seen repos,
 * live forge API repos (5-min cached), and namespace wildcards (`owner/*`).
 */
export async function listForgeRepositories(
  path: string,
  id: ForgeId,
  opts: { query?: string; recentRepos?: readonly string[]; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<ResourceItem[]> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const store = readStore(path);
  const saved = store[id];
  let live: string[] = [];

  if (saved?.token) {
    const cacheKey = `${path}:${id}`;
    const hit = repoCache.get(cacheKey);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      live = hit.repos;
    } else {
      try {
        live = await fetchRemoteRepos(id, saved, fetchImpl);
        repoCache.set(cacheKey, { at: now, repos: live });
      } catch {
        live = hit?.repos ?? [];
      }
    }
  }

  const seen = new Set<string>();
  const owners = new Set<string>();
  const recentItems: ResourceItem[] = [];
  const allItems: ResourceItem[] = [];
  const addOwner = (repo: string) => {
    const slash = repo.indexOf("/");
    if (slash > 0) owners.add(repo.slice(0, slash));
  };

  for (const repo of opts.recentRepos ?? []) {
    const clean = repo.trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    addOwner(clean);
    recentItems.push({ id: clean, label: clean, meta: "Recent", group: "recent" });
  }
  for (const repo of live) {
    const clean = repo.trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    addOwner(clean);
    allItems.push({ id: clean, label: clean, meta: META[id].title, group: "all" });
  }

  const wildcards: ResourceItem[] = [...owners].sort().map((owner) => ({
    id: `${owner}/*`,
    label: `${owner}/*`,
    meta: `All in ${owner}`,
    group: "wildcard",
  }));

  const q = (opts.query ?? "").trim().toLowerCase();
  const combined = [...wildcards, ...recentItems, ...allItems];
  return q ? combined.filter((item) => item.id.toLowerCase().includes(q) || (item.meta?.toLowerCase().includes(q) ?? false)) : combined;
}
