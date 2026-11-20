import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExternalApproval } from "../external-approvals.ts";
import { PASEO_BOT_ID } from "../paseo/gatekeeper.ts";
import { VaultStore } from "../vault-store.ts";
import { FETCH_BODY_MAX, needlesFor, parseFetchRequest, scrubBody } from "./fetch.ts";
import { parseProfile } from "./profile.ts";
import { createSecretsService, type Asker, type Caller } from "./service.ts";
import { SecretsError } from "./types.ts";

const SECRET = "sk-live-SUPERSECRETVALUE-0123456789";
const FANCY = "pa ss!(*)~é\"\\/+=&x";
const FP = `sha256:${"a".repeat(64)}`;
const agent: Caller = { id: "token-1", source: "adapter" };
const asker = (extra: Partial<Asker> = {}): Asker => ({ fingerprint: FP, project: "default", purpose: "deploy", ...extra });

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer }

let dir: string;
let server: Server;
let host: string;
let seen: Seen[];
let handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;
let clock: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-secrets-fetch-"));
  clock = Date.parse("2026-11-20T10:00:00Z");
  seen = [];
  handler = (_req, res) => res.end("ok");
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { timeoutMs?: number } = {}) {
  const vault = new VaultStore({ dataDir: dir, now: () => clock });
  const cards: ExternalApproval[] = [];
  const logs: string[] = [];
  const history: unknown[] = [];
  const service = createSecretsService({
    vault, dataDir: dir, approvals: { open: (card) => (cards.push(card), true), close: () => {} },
    paseoBot: () => ({ id: PASEO_BOT_ID, name: "Paseo", threadId: "thread-paseo" }), history: (entry) => history.push(entry),
    botExists: () => true, log: (message) => logs.push(message), now: () => clock, ...(options.timeoutMs ? { fetchTimeoutMs: options.timeoutMs } : {}),
  });
  const save = (ref: string, value: string, bots: "all" | string[] = [], allowedHosts: string[] = [host]) => vault.saveSecret({ name: ref, value, source: "settings", bots, profile: { allowedHosts } });
  const allow = (ref: string) => service.admin.grant({ ref, fingerprint: FP, purpose: "deploy", state: "allow", persist: true });
  const send = (ref: string, body: Record<string, unknown>, who: Asker = asker()) => service.fetch({ ref, request: parseFetchRequest({ url: `http://${host}/path`, ...body }), asker: who }, agent);
  return { vault, service, cards, logs, history, save, allow, send };
}

const refusal = async (run: () => Promise<unknown>): Promise<SecretsError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof SecretsError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
};

const decode = (data: { body: string }): string => Buffer.from(data.body, "base64").toString("latin1");

function everythingWritten(logs: string[]): string {
  const files = (root: string): string[] => readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? files(path) : name === "logins.json.enc" || name === "logins-key" ? [] : [readFileSync(path, "utf8")];
  });
  return JSON.stringify([logs, files(dir)]);
}

describe("a covered fetch", () => {
  it("sends the value as a bearer token, returns the destination's answer, and audits host, method and status only", async () => {
    const f = fixture();
    f.save("API_KEY", SECRET);
    f.allow("API_KEY");
    handler = (_req, res) => { res.setHeader("x-request-id", "r-1"); res.statusCode = 201; res.end("BODYTEXT"); };
    const answer = await f.send("API_KEY", { method: "post", headers: { "content-type": "application/json", "x-extra": "1" }, body: Buffer.from('{"a":1}').toString("base64") });
    expect(answer).toMatchObject({ status: 201, truncated: false });
    expect(answer.headers["x-request-id"]).toBe("r-1");
    expect(decode(answer)).toBe("BODYTEXT");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/path" });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen[0]!.headers["x-extra"]).toBe("1");
    expect(seen[0]!.headers["accept-encoding"]).toBe("identity");
    expect(seen[0]!.body.toString()).toBe('{"a":1}');
    const rows = f.service.auditFor(FP, {}).entries.filter((row) => row.context.startsWith("fetch"));
    expect(rows.map((row) => [row.decision, row.context, row.destHost, row.method, row.status])).toEqual([
      ["check", "fetch POST " + host + ": status 201", host, "POST", 201],
      ["allow", "fetch POST " + host, host, undefined, undefined],
    ]);
    expect(everythingWritten(f.logs)).not.toContain("SUPERSECRET");
    expect(everythingWritten(f.logs)).not.toContain("BODYTEXT");
  });

  it("writes each injection mode where the agent chose", async () => {
    const f = fixture();
    f.save("API_KEY", FANCY);
    f.allow("API_KEY");
    await f.send("API_KEY", { inject: { as: "header", name: "X-Api-Key" } });
    expect(seen[0]!.headers["x-api-key"]).toBe(FANCY);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    await f.send("API_KEY", { url: `http://${host}/q?keep=1&key=old`, inject: { as: "query", name: "key" } });
    const query = new URL(seen[1]!.url, "http://x").searchParams;
    expect(query.get("key")).toBe(FANCY);
    expect(query.get("keep")).toBe("1");
    await f.send("API_KEY", { inject: { as: "basic-password", name: "robot" } });
    expect(Buffer.from(seen[2]!.headers.authorization!.replace(/^Basic /, ""), "base64").toString()).toBe(`robot:${FANCY}`);
    await f.send("API_KEY", { inject: { as: "basic-password" } });
    expect(Buffer.from(seen[3]!.headers.authorization!.replace(/^Basic /, ""), "base64").toString()).toBe(`:${FANCY}`);
    await f.send("API_KEY", {});
    expect(seen[4]!.headers.authorization).toBe(`Bearer ${FANCY}`);
  });

  it("scrubs the raw, base64, base64url, URL-encoded, hex and JSON forms of the value from headers and body", async () => {
    const f = fixture();
    const value = "sk-live-a+b/c d!(*)~é-\"z-0123456789";
    f.save("API_KEY", value);
    f.allow("API_KEY");
    const bytes = Buffer.from(value);
    const forms = [
      value, bytes.toString("base64"), bytes.toString("base64").replace(/=+$/, ""), bytes.toString("base64url"), encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2), bytes.toString("hex"), bytes.toString("hex").toUpperCase(), JSON.stringify(value).slice(1, -1),
    ];
    handler = (_req, res) => {
      res.setHeader("x-echo", `token=${value}`);
      res.setHeader("x-echo-encoded", encodeURIComponent(value));
      res.end(forms.map((form) => `[${form}]`).join("\n"));
    };
    const answer = await f.send("API_KEY", { inject: { as: "query", name: "k" } });
    const body = decode(answer);
    for (const form of forms) expect(body, form).not.toContain(Buffer.from(form).toString("latin1"));
    expect(body.split("\n").every((line) => line === "[[omb:API_KEY]]")).toBe(true);
    expect(answer.headers["x-echo"]).toBe("token=[omb:API_KEY]");
    expect(answer.headers["x-echo-encoded"]).toBe("[omb:API_KEY]");
  });

  it("scrubs a value a destination echoes in the header it received, including the base64 credential of basic authentication", async () => {
    const f = fixture();
    f.save("API_KEY", SECRET);
    f.allow("API_KEY");
    handler = (req, res) => { res.setHeader("x-seen-auth", String(req.headers.authorization)); res.end(`you sent ${req.headers.authorization}`); };
    for (const inject of [{ as: "bearer" }, { as: "basic-password", name: "robot" }, { as: "header", name: "authorization" }]) {
      const answer = await f.send("API_KEY", { inject });
      const text = JSON.stringify([answer.headers, decode(answer)]);
      expect(text, JSON.stringify(inject)).not.toContain("SUPERSECRET");
      expect(text).not.toContain(Buffer.from(`robot:${SECRET}`).toString("base64"));
      expect(text).toContain("[omb:API_KEY]");
    }
  });

  it("scrubs a compressed answer after it is decoded", async () => {
    const f = fixture();
    f.save("API_KEY", SECRET);
    f.allow("API_KEY");
    handler = (_req, res) => { res.setHeader("content-encoding", "gzip"); res.end(gzipSync(`hello ${SECRET}`)); };
    const answer = await f.send("API_KEY", {});
    expect(decode(answer)).toBe("hello [omb:API_KEY]");
    expect(answer.headers["content-encoding"]).toBeUndefined();
  });

  it("returns a redirect as it is, scrubbed, and never follows it", async () => {
    const f = fixture();
    f.save("API_KEY", SECRET);
    f.allow("API_KEY");
    handler = (req, res) => {
      if (req.url?.startsWith("/target")) return res.end("target");
      res.statusCode = 302;
      res.setHeader("location", `http://${host}/target?echo=${encodeURIComponent(SECRET)}`);
      res.end();
    };
    const answer = await f.send("API_KEY", {});
    expect(answer.status).toBe(302);
    expect(answer.headers.location).toBe(`http://${host}/target?echo=[omb:API_KEY]`);
    expect(seen.map((one) => one.url)).toEqual(["/path"]);
  });

  it("cuts the body at the size cap and drops a trailing piece that starts the value", async () => {
    const f = fixture();
    f.save("API_KEY", SECRET);
    f.allow("API_KEY");
    const filler = ".".repeat(FETCH_BODY_MAX - 6);
    handler = (_req, res) => { res.end(Buffer.concat([Buffer.from(filler), Buffer.from(SECRET), Buffer.from(".".repeat(4_096))])); };
    const answer = await f.send("API_KEY", {});
    const bytes = Buffer.from(answer.body, "base64");
    expect(answer.truncated).toBe(true);
    expect(bytes.length).toBeLessThanOrEqual(FETCH_BODY_MAX);
    expect(/^\.+$/.test(bytes.subarray(-64).toString("latin1"))).toBe(true);
  });

  it("answers 5 when the destination does not answer in time, even when it stalls the body, and names neither the value nor the URL", async () => {
    const f = fixture({ timeoutMs: 250 });
    f.save("API_KEY", SECRET);
    f.allow("API_KEY");
    handler = (_req, res) => { res.write("partial"); };
    const stalled = await refusal(() => f.send("API_KEY", { url: `http://${host}/slow?x=1`, inject: { as: "query", name: "k" } }));
    expect(stalled).toMatchObject({ exit: 5, code: "upstream_failed" });
    handler = () => {};
    const silent = await refusal(() => f.send("API_KEY", { inject: { as: "query", name: "k" } }));
    expect(silent).toMatchObject({ exit: 5, code: "upstream_failed" });
    for (const error of [stalled, silent]) expect(`${error.message}`).not.toMatch(/SUPERSECRET|slow|127\.0\.0\.1/);
    const failed = f.service.auditFor(FP, {}).entries.filter((row) => row.errorCode === "upstream_failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ method: "GET", context: expect.stringContaining("timeout") });
    expect(everythingWritten(f.logs)).not.toContain("SUPERSECRET");
  });

  it("keeps a value out of the error when the connection fails and the URL carries it", async () => {
    const f = fixture();
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadHost = `127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    f.save("API_KEY", SECRET, [], [deadHost]);
    f.allow("API_KEY");
    const error = await refusal(() => f.send("API_KEY", { url: `http://${deadHost}/x`, inject: { as: "query", name: "token" } }));
    expect(error).toMatchObject({ exit: 5, code: "upstream_failed" });
    expect(error.message).toContain("ECONNREFUSED");
    expect(JSON.stringify([error.message, error.stack, f.logs, everythingWritten(f.logs)])).not.toContain("SUPERSECRET");
  });
});

describe("what a fetch refuses before the value is read", () => {
  it("refuses with 6 a host the person did not allow, and a secret with no allowed host, without filing a request or opening a card", async () => {
    const f = fixture();
    f.save("API_KEY", SECRET, [PASEO_BOT_ID], ["api.example.com"]);
    f.save("OPEN_KEY", SECRET, [], []);
    f.allow("API_KEY");
    expect(await refusal(() => f.send("API_KEY", {}))).toMatchObject({ exit: 6, code: "host_not_allowed" });
    expect(await refusal(() => f.send("OPEN_KEY", {}))).toMatchObject({ exit: 6, code: "host_not_allowed" });
    expect(await refusal(() => f.send("API_KEY", { url: `http://${host}/x` }, asker({ destHost: "api.example.com" })))).toMatchObject({ exit: 6 });
    expect(seen).toEqual([]);
    expect(f.service.admin.pending()).toEqual([]);
    expect(f.cards).toEqual([]);
    expect(f.service.auditFor(FP, {}).entries.some((row) => row.errorCode === "host_not_allowed" && row.destHost === host)).toBe(true);
  });

  it("allows plain http to a loopback host the person listed only", async () => {
    const f = fixture();
    f.save("API_KEY", SECRET, [], ["api.example.com", "localhost"]);
    f.allow("API_KEY");
    const plain = (url: string) => f.service.fetch({ ref: "API_KEY", request: parseFetchRequest({ url }), asker: asker() }, agent);
    expect(await refusal(() => plain("http://api.example.com/x"))).toMatchObject({ exit: 2, code: "invalid_request" });
    expect(await refusal(() => plain(`http://${host}/x`))).toMatchObject({ exit: 6, code: "host_not_allowed" });
    expect(seen).toEqual([]);
  });

  it("opens a card for a secret nobody approved, and sends nothing until the person answers", async () => {
    const f = fixture();
    f.save("CARD_KEY", SECRET, []);
    expect(await refusal(() => f.send("CARD_KEY", {}, asker({ agentLabel: "claude" })))).toMatchObject({ exit: 8, code: "approval_pending" });
    expect(f.cards).toHaveLength(1);
    expect(f.service.admin.pending()).toHaveLength(1);
    expect(seen).toEqual([]);
    f.cards[0]!.onAnswer("allow");
    await f.service.idle();
    expect((await f.send("CARD_KEY", {})).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("approves a secret kept to the Paseo bot at once, and the retry goes through", async () => {
    const f = fixture();
    f.save("API_KEY", SECRET, [PASEO_BOT_ID]);
    const first = await refusal(() => f.send("API_KEY", {}));
    expect(first).toMatchObject({ exit: 8, code: "approval_pending" });
    expect(first.message).toMatch(/approved it for 24 hours/);
    await f.service.idle();
    expect(f.cards).toEqual([]);
    expect(f.history).toHaveLength(1);
    expect(seen).toEqual([]);
    expect((await f.send("API_KEY", {})).status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it("refuses a block with 6 and a missing secret that a grant covers with 3", async () => {
    const f = fixture();
    f.save("API_KEY", SECRET);
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "block" });
    f.service.admin.grant({ ref: "GONE", fingerprint: FP, purpose: "deploy", state: "allow", persist: true });
    expect(await refusal(() => f.send("API_KEY", {}))).toMatchObject({ exit: 6, code: "blocked" });
    expect(await refusal(() => f.send("GONE", {}))).toMatchObject({ exit: 3, code: "no_such_secret" });
    expect(seen).toEqual([]);
  });

  it("refuses a value that cannot be a header, without naming it, and sends nothing", async () => {
    const f = fixture();
    f.save("LINE_KEY", "first-line-0123456789\nsecond");
    f.save("WIDE_KEY", "密码-0123456789-密码");
    f.allow("LINE_KEY");
    f.allow("WIDE_KEY");
    for (const ref of ["LINE_KEY", "WIDE_KEY"]) {
      const error = await refusal(() => f.send(ref, {}));
      expect(error).toMatchObject({ exit: 2, code: "invalid_request" });
      expect(error.message).not.toMatch(/first-line|second|密码/);
    }
    expect(seen).toEqual([]);
    await f.send("WIDE_KEY", { inject: { as: "query", name: "k" } });
    expect(new URL(seen[0]!.url, "http://x").searchParams.get("k")).toBe("密码-0123456789-密码");
  });

  it("refuses a value a header would trim, since the destination would get another value and echo a form the scrubber misses", async () => {
    const f = fixture();
    f.save("TAIL_KEY", "tail-space-0123456789 ");
    f.save("HEAD_KEY", " head-space-0123456789");
    f.allow("TAIL_KEY");
    f.allow("HEAD_KEY");
    expect(await refusal(() => f.send("TAIL_KEY", {}))).toMatchObject({ exit: 2, code: "invalid_request" });
    expect(await refusal(() => f.send("HEAD_KEY", { inject: { as: "header", name: "x-api-key" } }))).toMatchObject({ exit: 2, code: "invalid_request" });
    expect(seen).toEqual([]);
    await f.send("HEAD_KEY", {});
    expect(seen[0]!.headers.authorization).toBe("Bearer  head-space-0123456789");
  });

  it("leaves a single-release allow unspent and logs no release when the value cannot go into the request", async () => {
    const f = fixture();
    f.save("LINE_KEY", "first-line-0123456789\nsecond");
    f.service.admin.grant({ ref: "LINE_KEY", fingerprint: FP, purpose: "deploy", state: "allow", once: true });
    expect(await refusal(() => f.send("LINE_KEY", {}))).toMatchObject({ exit: 2, code: "invalid_request" });
    expect(f.service.admin.grants({})).toHaveLength(1);
    await f.send("LINE_KEY", { inject: { as: "query", name: "k" } });
    expect(seen).toHaveLength(1);
    expect(f.service.admin.grants({})).toHaveLength(0);
  });
});

describe("what the agent may send", () => {
  const ok = { url: "https://api.example.com/v1" };
  const bad = (body: Record<string, unknown>) => { try { parseFetchRequest({ ...ok, ...body }); } catch (error) { return error as SecretsError; } throw new Error("expected a refusal"); };

  it("refuses a header that would collide with the injection", () => {
    expect(bad({ headers: { Authorization: "Bearer x" } })).toMatchObject({ exit: 2 });
    expect(bad({ headers: { authorization: "Basic x" }, inject: { as: "basic-password" } })).toMatchObject({ exit: 2 });
    expect(bad({ headers: { "X-API-KEY": "x" }, inject: { as: "header", name: "x-api-key" } })).toMatchObject({ exit: 2 });
    expect(bad({ headers: { Cookie: "a=1" }, inject: { as: "header", name: "Cookie" } })).toMatchObject({ exit: 2 });
    expect(() => parseFetchRequest({ ...ok, headers: { Cookie: "a=1" } })).not.toThrow();
    expect(() => parseFetchRequest({ ...ok, headers: { Authorization: "Bearer x" }, inject: { as: "query", name: "k" } })).not.toThrow();
  });

  it("refuses a framing header, an encoding the scrubber could not read, a repeated header and a header with a line break", () => {
    for (const name of ["Host", "Content-Length", "Transfer-Encoding", "Connection", "Accept-Encoding"]) expect(bad({ headers: { [name]: "x" } }), name).toMatchObject({ exit: 2 });
    expect(bad({ headers: { "X-A": "1", "x-a": "2" } })).toMatchObject({ exit: 2 });
    expect(bad({ headers: { "X-A": "one\r\nX-B: two" } })).toMatchObject({ exit: 2 });
    expect(bad({ headers: { "bad name": "x" } })).toMatchObject({ exit: 2 });
  });

  it("refuses a URL with credentials or a scheme other than http and https, a bad method, a body on GET and a bad injection", () => {
    expect(bad({ url: "https://user:pass@api.example.com/" })).toMatchObject({ exit: 2 });
    expect(bad({ url: "ftp://api.example.com/" })).toMatchObject({ exit: 2 });
    expect(bad({ url: "not a url" })).toMatchObject({ exit: 2 });
    expect(bad({ method: "TRACE" })).toMatchObject({ exit: 2 });
    expect(bad({ body: Buffer.from("x").toString("base64") })).toMatchObject({ exit: 2 });
    expect(bad({ method: "POST", body: "not base64!" })).toMatchObject({ exit: 2 });
    for (const inject of [{ as: "cookie" }, { as: "header" }, { as: "query" }, { as: "bearer", name: "x" }, { as: "basic-password", name: "a:b" }, { as: "header", name: "bad name" }, { as: "header", name: "host" }, { as: "bearer", extra: 1 }, "bearer"]) {
      expect(bad({ inject }), JSON.stringify(inject)).toMatchObject({ exit: 2 });
    }
  });
});

describe("the hosts a person lists", () => {
  it("are written in one form, and a wildcard, a scheme, a path or a user is refused", () => {
    expect(parseProfile({ allowedHosts: ["API.Example.com.", "api.example.com:443", "localhost:8080", "bücher.example"] })).toEqual({
      ok: true, profile: { allowedHosts: ["api.example.com", "localhost:8080", "xn--bcher-kva.example"] },
    });
    for (const host of ["*.example.com", "*", "https://api.example.com", "api.example.com/v1", "user@api.example.com", "a b.com", ""]) {
      expect(parseProfile({ allowedHosts: [host] }), host).toMatchObject({ ok: false });
    }
    expect(parseProfile({ allowedHosts: Array.from({ length: 21 }, (_, i) => `h${i}.example.com`) })).toMatchObject({ ok: false });
  });
});

describe("scrubbing a cut body", () => {
  it("removes every form of the value, and a partial form only at the cut", () => {
    const request = parseFetchRequest({ url: "https://api.example.com/", inject: { as: "bearer" } });
    const needles = needlesFor(request, SECRET);
    expect(scrubBody(Buffer.from(`a ${SECRET} b ${SECRET}`), needles, "[X]", false).toString()).toBe("a [X] b [X]");
    expect(scrubBody(Buffer.from(`a sk-live-SUP`), needles, "[X]", false).toString()).toBe("a sk-live-SUP");
    expect(scrubBody(Buffer.from(`a sk-live-SUP`), needles, "[X]", true).toString()).toBe("a ");
  });
});
