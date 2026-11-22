import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { probeMcpV2 } from "./probe.ts";
import { startFakeV2Server, type FakeV2Server } from "./testing/fake-v2-server.ts";

let fake: FakeV2Server;
const closers: Array<() => void> = [];

beforeEach(async () => {
  fake = await startFakeV2Server();
});

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await fake.close();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

/** A server that forwards to the fake one and edits each JSON result on the way back. */
function editing(edit: (result: Record<string, unknown>, method: string) => void): Promise<string> {
  return listen(createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    let method = "";
    try { method = JSON.parse(body.toString()).method as string; } catch { /* not JSON */ }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => key !== "host" && key !== "content-length").map(([key, value]) => [key, String(value)]));
    const upstream = await fetch(fake.url, { method: req.method ?? "POST", headers, ...(req.method === "POST" ? { body } : {}) });
    let text = await upstream.text();
    try {
      const json = JSON.parse(text);
      if (json.result) { edit(json.result, method); text = JSON.stringify(json); }
    } catch { /* keep the text */ }
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(text);
  }));
}

const oneLine = (error: string) => {
  expect(error).not.toMatch(/\n|ZodError|\bat \S+:\d+|\[\s*\{|invalid_type/);
};

it("shows the server, its tools, its events and its extensions", async () => {
  const result = await probeMcpV2({ url: fake.url, headers: {} }, new AbortController().signal);
  expect(result).toMatchObject({
    ok: true,
    total: 2,
    v2: { server: { name: "fake-v2", version: "2.0.1" }, extensions: ["io.modelcontextprotocol/tasks", "io.modelcontextprotocol/events"], events: ["workflow_run.status_changed"] },
  });
  expect(result.ok && result.tools.map((tool) => tool.name)).toEqual(["run_workflow", "get_run"]);
});

it("names the missing field of a server that leaves out resultType, ttlMs or cacheScope", async () => {
  for (const field of ["resultType", "ttlMs", "cacheScope"]) {
    const url = await editing((result, method) => { if (method === "tools/list") delete result[field]; });
    const result = await probeMcpV2({ url, headers: {} }, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.error).toContain(field);
    expect(result.error).toContain("MCP 2026-07-28");
    oneLine(result.error);
  }
});

it("says a legacy-only server does not speak 2026-07-28", async () => {
  const legacy = await startFakeV2Server({ mode: "legacy" });
  try {
    const result = await probeMcpV2({ url: legacy.url, headers: {} }, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("does not speak MCP 2026-07-28") });
  } finally {
    await legacy.close();
  }
});

it("reports refused keys with the keys reason", async () => {
  const url = await listen(createServer((req, res) => { req.resume(); res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); }));
  const result = await probeMcpV2({ url, headers: { authorization: "Bearer wrong" } }, new AbortController().signal);
  expect(result).toMatchObject({ ok: false, reason: "keys", status: 401 });
  expect(JSON.stringify(result)).not.toContain("wrong");
});

it("reports an address nobody listens on as unreachable", async () => {
  const closed = createServer();
  const url = await listen(closed);
  closed.closeAllConnections();
  await new Promise((resolve) => closed.close(resolve));
  const result = await probeMcpV2({ url, headers: {} }, new AbortController().signal);
  expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  oneLine(result.ok ? "" : result.error);
});

it("stops at once when the caller cancels and when the time is up", async () => {
  const url = await listen(createServer((req) => { req.resume(); }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  expect(await probeMcpV2({ url, headers: {} }, controller.signal)).toEqual({ ok: false, error: "Connection test was cancelled." });
  expect(await probeMcpV2({ url, headers: {} }, new AbortController().signal, { timeoutMs: 150 })).toMatchObject({ ok: false, reason: "timeout" });
});
