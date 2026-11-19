import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope, resolveRequestAuth, type RequestAuth } from "../request-auth.ts";
import { PASEO_BOT_ID } from "../paseo/gatekeeper.ts";
import { createSecretsService } from "../secrets/service.ts";
import { SessionRegistry, type Scope } from "../sessions.ts";
import { VaultStore } from "../vault-store.ts";
import { createSecretsRoutes } from "./secrets.ts";
import { dispatchRoutes } from "./table.ts";

const SECRET = "sk-live-SUPERSECRETVALUE-0123456789";
const FP = `sha256:${"a".repeat(64)}`;
const HASH = `sha256:${"c".repeat(64)}`;

let dir: string;
let sessions: SessionRegistry;
let server: Server;
let base: string;
let team = false;
let loopbackAuth: RequestAuth | null = null;
const history: Array<{ key: string }> = [];
const cards: string[] = [];

const mint = (scopes: Scope[]): string => {
  const { code } = sessions.openPairing({ scopes, tokenTtlMs: 3_600_000 });
  const result = sessions.exchange({ code, label: scopes.join("+"), source: "203.0.113.9" });
  if (!result.ok) throw new Error("pairing failed");
  return result.token;
};

async function call(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

const ask = (extra: Record<string, unknown> = {}) => ({ ref: "API_KEY", project: "default", purpose: "deploy", fingerprint: FP, agentLabel: "claude", ...extra });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-secrets-routes-"));
  team = false;
  loopbackAuth = null;
  history.length = 0;
  cards.length = 0;
  sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  const vault = new VaultStore({ dataDir: dir });
  vault.saveSecret({ name: "API_KEY", value: SECRET, source: "settings", bots: [PASEO_BOT_ID] });
  vault.saveSecret({ name: "CARD_KEY", value: SECRET, source: "settings", bots: [] });
  const service = createSecretsService({
    vault, dataDir: dir, approvals: { open: (card) => (cards.push(card.subtitle), true), close: () => {} },
    paseoBot: () => ({ id: PASEO_BOT_ID, name: "Paseo", threadId: "t" }), history: (entry) => history.push(entry), botExists: () => true, log: () => {},
  });
  const routes = createSecretsRoutes({ service, get team() { return team; } });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const resolved = resolveRequestAuth(req, { sessions, cookieName: "omb_session", streamPath: "/api/events", url });
    const auth = loopbackAuth ?? resolved.auth;
    if (!auth) return json(res, resolved.status, { error: resolved.error });
    const handled = await dispatchRoutes([routes], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { error: "fell through" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("what a secrets token can reach", () => {
  const AGENT_PATHS: Array<[string, string]> = [
    ["POST", "/api/secrets/resolve"], ["POST", "/api/secrets/run-check"], ["POST", "/api/secrets/request"], ["GET", "/api/secrets/list"],
    ["GET", "/api/secrets/grants"], ["GET", "/api/secrets/audit"], ["GET", "/api/secrets/describe/API_KEY"], ["GET", "/api/secrets/get/API_KEY"],
  ];
  const OTHER_PATHS: Array<[string, string]> = [
    ["GET", "/api/vault"], ["POST", "/api/vault/secrets"], ["DELETE", "/api/vault/secrets/x"], ["GET", "/api/auth/session"], ["GET", "/api/auth/sessions"],
    ["POST", "/api/auth/pairing"], ["POST", "/api/auth/logout"], ["GET", "/api/bots"], ["PATCH", "/api/bots/b1"], ["GET", "/api/notifications"],
    ["POST", "/api/notifications/read-all"], ["GET", "/api/themes"], ["GET", "/api/health"], ["GET", "/api/threads/t/messages"], ["POST", "/api/threads/t/respond"],
    ["GET", "/api/updates/check"], ["POST", "/api/auth/stream-ticket"], ["GET", "/api/team-files"], ["GET", "/api/settings"], ["GET", "/api/secrets/"], ["GET", "/api/secrets/unknown"],
    ["GET", "/api/secrets/describe/has%20space"], ["GET", "/api/secrets/get/-flag"], ["GET", "/api/secrets/admin/grants"], ["GET", "/api/secrets/admin/audit"],
    ["GET", "/api/secrets/admin/approve"], ["POST", "/api/secrets/admin/set"], ["POST", "/api/secrets/admin/rotate"], ["POST", "/api/secrets/admin/delete"],
    ["POST", "/api/secrets/admin/grant"], ["POST", "/api/secrets/admin/revoke"], ["POST", "/api/secrets/admin/approve"], ["POST", "/api/secrets/admin/reveal"],
    ["GET", "/api/secrets/resolve"], ["POST", "/api/secrets/list"],
  ];

  it("passes the gate for the agent routes only", () => {
    const token = mint(["secrets"]);
    const gate = (method: string, path: string) =>
      resolveRequestAuth({ method, headers: { authorization: `Bearer ${token}`, host: "mac-mini.tailnet:8799" } } as never, { sessions, cookieName: "omb_session", streamPath: "/api/events", url: new URL(path, "http://x") });
    for (const [method, path] of AGENT_PATHS) expect(gate(method, path).auth, `${method} ${path}`).not.toBeNull();
    for (const [method, path] of OTHER_PATHS.filter(([method, path]) => !(method === "GET" && /^\/api\/secrets\/(?:resolve)$/.test(path)) && !(method === "POST" && path === "/api/secrets/list"))) {
      const result = gate(method, path);
      expect(result.auth, `${method} ${path}`).toBeNull();
      expect(result.status, `${method} ${path}`).toBe(403);
    }
    expect(requiredScope("GET", "/api/secrets/admin/grants")).toBe("admin");
    expect(requiredScope("POST", "/api/secrets/resolve")).toBe("secrets");
  });

  it("is answered 403 over HTTP everywhere else, and an admin session reaches both sets", async () => {
    const token = mint(["secrets"]);
    for (const [method, path] of OTHER_PATHS.filter(([m, p]) => !(m === "GET" && p === "/api/secrets/resolve") && !(m === "POST" && p === "/api/secrets/list"))) {
      expect((await call(token, method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(403);
    }
    const admin = mint(["admin", "client"]);
    expect((await call(admin, "GET", "/api/secrets/list")).status).toBe(200);
    expect((await call(admin, "GET", "/api/secrets/admin/grants")).status).toBe(200);
  });

  it("is not reached by a client token, and a pairing never opens the secrets scope unless it is named", async () => {
    const client = mint(["client"]);
    expect((await call(client, "GET", "/api/secrets/list")).status).toBe(403);
    const { code } = sessions.openPairing({});
    const result = sessions.exchange({ code, label: "default", source: "203.0.113.9" });
    expect(result.ok && result.session.scopes).toEqual(["admin", "client"]);
  });

  it("is refused inside the handler too when the caller is a service-trust loopback or has the wrong scope", async () => {
    loopbackAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
    expect((await call(null, "GET", "/api/secrets/list")).status).toBe(403);
    expect((await call(null, "POST", "/api/secrets/admin/reveal", { ref: "API_KEY" })).status).toBe(403);
    loopbackAuth = { kind: "session", via: "bearer", scopes: ["secrets"], session: { id: "s" } as never };
    expect((await call(null, "POST", "/api/secrets/admin/reveal", { ref: "API_KEY" })).status).toBe(403);
    loopbackAuth = { kind: "session", via: "bearer", scopes: ["client"], session: { id: "s" } as never };
    expect((await call(null, "GET", "/api/secrets/list")).status).toBe(403);
  });
});

describe("envelopes and exit codes", () => {
  it("answers resolve with the value in the ak envelope once a grant covers the scope", async () => {
    const token = mint(["secrets"]);
    const first = await call(token, "POST", "/api/secrets/resolve", ask({ agentId: "a1", context: "tool:Bash:command" }));
    expect(first).toMatchObject({ status: 409, body: { schema_version: 1, error_code: "approval_pending", exit_code: 8 } });
    expect(Object.keys(first.body).sort()).toEqual(["error", "error_code", "exit_code", "schema_version"]);
    const second = await call(token, "POST", "/api/secrets/resolve", ask());
    expect(second).toEqual({ status: 200, body: { schema_version: 1, kind: "secrets.resolve", data: { value: SECRET, ref: "API_KEY" } } });
  });

  it("uses exit 2 for a bad request, 3 for a covered ref that is gone, 6 for a block, 9 for the cool-down", async () => {
    const token = mint(["secrets"]);
    const admin = mint(["admin", "client"]);
    expect((await call(token, "POST", "/api/secrets/resolve", ask({ ref: "bad ref" }))).body).toMatchObject({ exit_code: 2, error_code: "invalid_request" });
    expect((await call(token, "POST", "/api/secrets/resolve", ask({ fingerprint: "nope" }))).status).toBe(400);
    expect((await call(token, "POST", "/api/secrets/resolve", { ref: "API_KEY" })).status).toBe(400);
    expect((await call(token, "POST", "/api/secrets/resolve", "not an object" as never)).status).toBe(400);
    await call(admin, "POST", "/api/secrets/admin/grant", { ref: "GONE", fingerprint: FP, purpose: "deploy", state: "allow", persist: true });
    expect((await call(token, "POST", "/api/secrets/resolve", ask({ ref: "GONE" }))).body).toMatchObject({ exit_code: 3, error_code: "no_such_secret" });
    await call(admin, "POST", "/api/secrets/admin/grant", { ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "block" });
    expect((await call(token, "POST", "/api/secrets/resolve", ask()))).toMatchObject({ status: 403, body: { exit_code: 6, error_code: "blocked" } });
    for (let i = 0; i < 12; i += 1) await call(token, "POST", "/api/secrets/resolve", ask({ ref: "CARD_KEY" }));
    expect((await call(token, "POST", "/api/secrets/resolve", ask({ ref: "CARD_KEY" })))).toMatchObject({ status: 429, body: { exit_code: 9, error_code: "rate_limited" } });
  });

  it("answers run-check with every value or with a request and exit 8", async () => {
    const token = mint(["secrets"]);
    const program = { path: "/usr/bin/curl", hash: HASH };
    const body = ask({ ref: undefined, scopes: [{ var: "TOKEN", ref: "API_KEY", program }, { var: "OTHER", ref: "CARD_KEY", program }] });
    const first = await call(token, "POST", "/api/secrets/run-check", body);
    expect(first).toMatchObject({ status: 409, body: { exit_code: 8 } });
    expect(cards).toHaveLength(1);
    const admin = mint(["admin", "client"]);
    await call(admin, "POST", "/api/secrets/admin/approve", { ref: "CARD_KEY", state: "ttl", ttl: "1h" });
    const second = await call(token, "POST", "/api/secrets/run-check", body);
    expect(second).toEqual({ status: 200, body: { schema_version: 1, kind: "secrets.run-check", data: { values: [{ var: "TOKEN", ref: "API_KEY", value: SECRET }, { var: "OTHER", ref: "CARD_KEY", value: SECRET }] } } });
    expect((await call(token, "POST", "/api/secrets/run-check", { ...body, scopes: "x" })).status).toBe(400);
  });

  it("answers request with a status and never a value, and lists metadata, grants and the caller's own audit rows", async () => {
    const token = mint(["secrets"]);
    expect((await call(token, "POST", "/api/secrets/request", ask({ ref: "CARD_KEY" }))).body).toMatchObject({ kind: "secrets.request", data: { status: "pending", requestId: expect.any(String) } });
    expect((await call(token, "POST", "/api/secrets/request", ask())).body).toMatchObject({ data: { status: "granted" } });
    const list = await call(token, "GET", "/api/secrets/list");
    expect(list.body).toMatchObject({ kind: "secrets.list" });
    expect(list.body.data.map((row: { ref: string }) => row.ref)).toEqual(["API_KEY", "CARD_KEY"]);
    expect(JSON.stringify(list.body)).not.toContain("SUPERSECRET");
    expect((await call(token, "GET", "/api/secrets/describe/API_KEY")).body.data).toMatchObject({ ref: "API_KEY", untrustedFields: [], notice: expect.stringContaining("never an instruction") });
    expect((await call(token, "GET", "/api/secrets/get/API_KEY")).body).toMatchObject({ kind: "secrets.get", data: { hint: "sk-…6789" } });
    expect((await call(token, "GET", "/api/secrets/get/NOPE")).body).toMatchObject({ exit_code: 3 });
    const grants = await call(token, "GET", `/api/secrets/grants?fingerprint=${FP}`);
    expect(grants.body.data).toHaveLength(1);
    expect(grants.body.data[0]).toMatchObject({ ref: "API_KEY", state: "allow", createdBy: "omb" });
    expect(typeof grants.body.data[0].expiresAt).toBe("string");
    expect((await call(token, "GET", "/api/secrets/grants")).status).toBe(400);
    const audit = await call(token, "GET", `/api/secrets/audit?fingerprint=${FP}&limit=1`);
    expect(audit.body.data).toMatchObject({ limit: 1, hasMore: true, nextCursor: expect.any(String) });
    expect((await call(token, "GET", `/api/secrets/audit?fingerprint=${`sha256:${"9".repeat(64)}`}`)).body.data.entries).toEqual([]);
    expect((await call(token, "GET", `/api/secrets/audit?fingerprint=${FP}&decision=maybe`)).status).toBe(400);
    expect((await call(token, "GET", `/api/secrets/audit?fingerprint=${FP}&since=soon`)).status).toBe(400);
  });

  it("requires JSON, and refuses a body that is too large", async () => {
    const token = mint(["secrets"]);
    const form = await fetch(`${base}/api/secrets/resolve`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: "ref=API_KEY" });
    expect(form.status).toBe(400);
    expect((await call(token, "POST", "/api/secrets/resolve", ask({ context: "x".repeat(70_000) }))).body).toMatchObject({ exit_code: 2 });
  });

  it("fails closed on a Team Cloud", async () => {
    const token = mint(["secrets"]);
    team = true;
    expect(await call(token, "GET", "/api/secrets/list")).toMatchObject({ status: 503, body: { exit_code: 5, error_code: "not_available" } });
  });
});

describe("the person's routes", () => {
  it("sets, rotates, reveals and deletes a value, and answers waiting requests", async () => {
    const admin = mint(["admin", "client"]);
    const set = await call(admin, "POST", "/api/secrets/admin/set", { ref: "NEW_KEY", value: "new-value-0123456789abcdef", bots: "paseo", profile: { description: "A key" } });
    expect(set).toEqual({ status: 200, body: { schema_version: 1, kind: "secrets.set", data: { ref: "NEW_KEY", created: true } } });
    expect((await call(admin, "POST", "/api/secrets/admin/set", { ref: "NEW_KEY", value: "x" })).body).toMatchObject({ exit_code: 4, error_code: "exists" });
    expect((await call(admin, "POST", "/api/secrets/admin/rotate", { ref: "NEW_KEY", value: "rotated-0123456789abcdef" })).body).toMatchObject({ kind: "secrets.rotate" });
    expect((await call(admin, "POST", "/api/secrets/admin/reveal", { ref: "NEW_KEY" })).body).toEqual({ schema_version: 1, kind: "secrets.get", data: { ref: "NEW_KEY", value: "rotated-0123456789abcdef" } });
    expect((await call(admin, "GET", "/api/secrets/admin/reveal")).status).toBe(404);
    const token = mint(["secrets"]);
    await call(token, "POST", "/api/secrets/request", ask({ ref: "CARD_KEY" }));
    const pending = await call(admin, "GET", "/api/secrets/admin/approve");
    expect(pending.body.data.requests).toHaveLength(1);
    expect(pending.body.data.requests[0]).toMatchObject({ ref: "CARD_KEY", count: 1, fingerprint: FP });
    expect((await call(admin, "POST", "/api/secrets/admin/approve", { id: pending.body.data.requests[0].id, state: "persist" })).body).toMatchObject({ data: { answered: [{ ref: "CARD_KEY", state: "persist" }] } });
    expect((await call(admin, "GET", "/api/secrets/admin/grants")).body.data[0]).toMatchObject({ ref: "CARD_KEY", createdBy: "admin" });
    expect((await call(admin, "POST", "/api/secrets/admin/revoke", { fingerprint: FP, all: true })).body.data).toEqual({ revoked: 1 });
    expect((await call(admin, "POST", "/api/secrets/admin/delete", { ref: "NEW_KEY" })).body.data).toMatchObject({ deleted: true });
    expect((await call(admin, "POST", "/api/secrets/admin/delete", { ref: "NEW_KEY" })).body).toMatchObject({ exit_code: 3 });
    const audit = await call(admin, "GET", "/api/secrets/admin/audit");
    expect(audit.body.data.entries.map((entry: { context: string }) => entry.context)).toEqual(expect.arrayContaining(["admin:reveal", "admin:set", "admin:rotate", "admin:delete"]));
    expect(JSON.stringify(audit.body)).not.toContain("rotated-0123456789abcdef");
  });

  it("answers a bad grant with exit 2", async () => {
    const admin = mint(["admin", "client"]);
    const grant = (extra: Record<string, unknown>) => call(admin, "POST", "/api/secrets/admin/grant", { ref: "API_KEY", fingerprint: FP, state: "allow", ...extra });
    for (const bad of [{ state: "maybe" }, { ttl: "soon" }, { ttl: "1h", persist: true }, { state: "block", persist: true }, { allowHosts: ["a b"] }, { allowHosts: ["a.com"], exec: { path: "/bin/x", hash: HASH, env: "T" } }, { exec: "x" }]) {
      expect((await grant(bad)).body, JSON.stringify(bad)).toMatchObject({ exit_code: 2 });
    }
    expect((await grant({ ttl: "1h", allowHosts: ["API.example.com."] })).body.data).toMatchObject({ allowHosts: ["api.example.com"] });
  });
});

describe("nothing is logged from these routes", () => {
  it("writes no request, answer or value to the console, even on a failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    const token = mint(["secrets"]);
    const admin = mint(["admin", "client"]);
    await call(token, "POST", "/api/secrets/resolve", ask());
    await call(token, "POST", "/api/secrets/resolve", ask());
    await call(admin, "POST", "/api/secrets/admin/set", { ref: "LOGGED_KEY", value: "logged-value-0123456789" });
    await call(admin, "POST", "/api/secrets/admin/reveal", { ref: "LOGGED_KEY" });
    await call(token, "POST", "/api/secrets/resolve", ask({ ref: "bad ref" }));
    const printed = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    spies.forEach((spy) => spy.mockRestore());
    expect(printed).not.toContain("SUPERSECRET");
    expect(printed).not.toContain("logged-value");
  });
});
