// A real server on an isolated data folder, and the fake MCP 2026-07-28 server on a free port.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { startFakeV2Server, type FakeV2Server } from "./mcp-v2/testing/fake-v2-server.ts";

let fixture: VerificationServer;
let fake: FakeV2Server;
let url: string;
let dataDir: string;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const listed = async (name: string) => (await api("GET", "/api/mcp/servers")).body.servers.find((server: any) => server.name === name);

beforeAll(async () => {
  fake = await startFakeV2Server();
  fixture = await launchVerificationServer({});
  ({ url, dataDir } = fixture.info);
}, 90_000);

afterAll(async () => {
  await fixture?.close();
  await fake?.close();
});

it("saves a v2 connection, lists it as MausBot only and gives it to no bot", async () => {
  const saved = await api("POST", "/api/mcp/servers", { name: "archon", type: "http", protocol: "v2", url: fake.url, headers: { Authorization: "Bearer e2e-key" } });
  expect(saved.status).toBe(201);
  expect(await listed("archon")).toMatchObject({ protocol: "v2", ombOnly: true, type: "http", headerKeys: ["Authorization"] });
  expect(JSON.stringify(saved.body)).not.toContain("e2e-key");
  const stored = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).mcpServers.archon;
  expect(stored).toMatchObject({ protocol: "v2", type: "http" });
  const legacy = await api("POST", "/api/mcp/servers", { name: "plain", type: "http", url: "https://example.com/mcp" });
  expect(legacy.status).toBe(201);
  const bots = (await api("GET", "/api/bots")).body.bots as Array<{ id: string }>;
  const offered = (await api("GET", `/api/bots/${bots[0]!.id}/mcp-servers`)).body.servers as Array<{ name: string }>;
  expect(offered.map((server) => server.name), "the bot's server list offers the standard entry and never the v2 one").toEqual(["plain"]);
  expect(await listed("plain")).toMatchObject({ protocol: "legacy" });
  expect(await listed("plain")).not.toHaveProperty("ombOnly");
}, 60_000);

it("tests a v2 connection and shows its tools, events and extensions", async () => {
  const tested = await api("POST", "/api/mcp/servers/archon/test");
  expect(tested.status).toBe(200);
  expect(tested.body).toMatchObject({
    ok: true,
    tools: [{ name: "run_workflow" }, { name: "get_run" }],
    v2: { server: { name: "fake-v2", version: "2.0.1" }, extensions: ["io.modelcontextprotocol/tasks", "io.modelcontextprotocol/events"], events: ["workflow_run.status_changed"] },
  });
  expect(fake.requests.some((request) => request.headers.authorization === "Bearer e2e-key")).toBe(true);
}, 60_000);

it("refuses a v2 connection with the SSE transport", async () => {
  const refused = await api("POST", "/api/mcp/servers", { name: "sse", type: "sse", protocol: "v2", url: fake.url });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toMatch(/SSE/);
  expect(await listed("sse")).toBeUndefined();
});
