import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globMatch } from "../pr-orchestrator/glob.ts";
import {
  clearForgeRepoCache,
  connectForgeApp,
  disconnectForgeApp,
  forgeIdOfApp,
  listForgeApps,
  listForgeRepositories,
  normalizeForgeUrl,
} from "./forge-connections.ts";

const dirs: string[] = [];
const tempStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-forge-apps-"));
  dirs.push(dir);
  return join(dir, "forge-apps.json");
};

afterEach(() => {
  clearForgeRepoCache();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const stubFetch = (handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const res = handler(String(input), init);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

describe("forge-connections", () => {
  it("validates PAT on connect, stores write-only (0600), lists repos with wildcards, and clears on disconnect", async () => {
    const store = tempStore();
    expect(listForgeApps(store).every((a) => !a.connected)).toBe(true);

    const calls: string[] = [];
    const fakeFetch = stubFetch((url) => {
      calls.push(url);
      if (url.endsWith("/user")) return { status: 200, body: { login: "kevinle128" } };
      if (url.includes("/user/repos")) {
        return { status: 200, body: [{ full_name: "kevinle128/OpenMausBot" }, { full_name: "kevinle128/paseo" }] };
      }
      return { status: 404, body: {} };
    });

    const connected = await connectForgeApp(store, "github", { token: "ghp_secret_token_123" }, fakeFetch);
    expect(connected).toMatchObject({ id: "github", connected: true, login: "kevinle128" });
    expect(JSON.stringify(connected)).not.toContain("ghp_secret_token_123");
    if (process.platform !== "win32") expect(statSync(store).mode & 0o777).toBe(0o600);

    const items = await listForgeRepositories(store, "github", { recentRepos: ["kevinle128/OpenMausBot"], fetchImpl: fakeFetch });
    expect(items.map((i) => `${i.group}:${i.id}`)).toEqual([
      "wildcard:kevinle128/*",
      "recent:kevinle128/OpenMausBot",
      "all:kevinle128/paseo",
    ]);

    const filtered = await listForgeRepositories(store, "github", { query: "paseo", recentRepos: ["kevinle128/OpenMausBot"], fetchImpl: fakeFetch });
    expect(filtered.map((i) => i.id)).toEqual(["kevinle128/paseo"]);
    // Cached: /user/repos was called only once.
    expect(calls.filter((u) => u.includes("/user/repos"))).toHaveLength(1);

    const disconnected = disconnectForgeApp(store, "github");
    expect(disconnected).toMatchObject({ id: "github", connected: false, login: null });
    expect(readFileSync(store, "utf8")).not.toContain("ghp_secret_token_123");
  });

  it("supports self-hosted GitLab URLs and rejects invalid tokens or non-https URLs", async () => {
    const store = tempStore();
    await expect(connectForgeApp(store, "gitlab", { token: "glpat_ok", baseUrl: "http://evil.example.com" })).rejects.toThrow(/https/);

    const badFetch = stubFetch(() => ({ status: 401, body: { message: "401 Unauthorized" } }));
    await expect(connectForgeApp(store, "gitlab", { token: "glpat_bad", baseUrl: "https://git.oceanlabs.dev" }, badFetch)).rejects.toThrow(/rejected/);

    const seenInits: Array<RequestInit | undefined> = [];
    const okFetch = stubFetch((url, init) => {
      seenInits.push(init);
      if (url === "https://git.oceanlabs.dev/api/v4/user") return { status: 200, body: { username: "kevin.le" } };
      if (url.startsWith("https://git.oceanlabs.dev/api/v4/projects")) {
        return { status: 200, body: [{ path_with_namespace: "vtc/backend/api" }] };
      }
      return { status: 404, body: {} };
    });
    const gl = await connectForgeApp(store, "gitlab", { token: "glpat_good", baseUrl: "https://git.oceanlabs.dev/" }, okFetch);
    expect(gl).toMatchObject({ id: "gitlab", connected: true, login: "kevin.le", baseUrl: "https://git.oceanlabs.dev" });
    expect(seenInits.every((init) => init?.redirect === "error")).toBe(true);

    const projects = await listForgeRepositories(store, "gitlab", { fetchImpl: okFetch });
    expect(projects.map((p) => p.id)).toEqual(["vtc/**", "vtc/backend/api"]);
    expect(globMatch(projects[0]!.id, "vtc/backend/api")).toBe(true);
    expect(forgeIdOfApp("gitlab-event")).toBe("gitlab");
    expect(forgeIdOfApp("github")).toBe("github");
  });

  it("blocks query/hash URLs and private/loopback addresses on hosted installs", () => {
    expect(() => normalizeForgeUrl("https://git.example.com/?a=1")).toThrow(/query/);
    expect(() => normalizeForgeUrl("https://git.example.com/#frag")).toThrow(/query/);
    expect(normalizeForgeUrl("http://127.0.0.1:8080/", { hosted: false })).toBe("http://127.0.0.1:8080");
    expect(() => normalizeForgeUrl("http://127.0.0.1:8080", { hosted: true })).toThrow(/https/);
    expect(() => normalizeForgeUrl("https://169.254.169.254", { hosted: true })).toThrow(/private|link-local/);
    expect(() => normalizeForgeUrl("https://10.0.0.5", { hosted: true })).toThrow(/private|link-local/);
    expect(normalizeForgeUrl("https://git.example.com/gitlab/", { hosted: true })).toBe("https://git.example.com/gitlab");
  });
});
