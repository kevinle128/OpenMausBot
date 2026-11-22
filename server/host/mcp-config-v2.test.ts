import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR, type AppConfig } from "../config.ts";
import { McpOAuthManager } from "../mcp-oauth.ts";
import * as probeModule from "../mcp-probe.ts";
import { listMcpServers, type StoredMcpServer } from "../mcp-registry.ts";
import { startFakeV2Server, type FakeV2Server } from "../mcp-v2/testing/fake-v2-server.ts";
import { createMcpConfig } from "./mcp-config.ts";
import type { TeamConnectionsHost } from "./team-connections-host.ts";

let fake: FakeV2Server | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await fake?.close();
  fake = undefined;
});

function fixture(personal: string[] = []) {
  const cfg: Pick<AppConfig, "mcpServers" | "postiz"> = { mcpServers: {} };
  let busy = false;
  const config = createMcpConfig({
    cfg,
    sessions: { isLive: () => true },
    mcpOAuth: new McpOAuthManager({ file: join(DATA_DIR, "mcp-config-v2-oauth.json") }),
    teamConnections: { personMcp: () => personal, people: {} as TeamConnectionsHost["people"] },
    cloudHome: null,
    fallbackPublicUrl: null,
    mcpConfigBusy: { get: () => busy, set: (value) => { busy = value; } },
    mcpServerResponse: () => ({ servers: listMcpServers(cfg.mcpServers) }),
    mcpPolicyRefusal: () => undefined,
    persistMcpServers: (next) => { cfg.mcpServers = next; },
    savedCustomDomain: () => null,
    changed: () => {},
  });
  return { cfg, config };
}

const v2 = (url: string): StoredMcpServer => ({ type: "http", protocol: "v2", url, headers: { Authorization: "Bearer test-key" }, enabled: true, apps: false }) as StoredMcpServer;

describe("testing an MCP v2 connection", () => {
  it("connects with the v2 client, never the legacy probe, and shows tools, events and extensions", async () => {
    fake = await startFakeV2Server();
    const legacy = vi.spyOn(probeModule, "probeMcpServer");
    const { config } = fixture();
    expect(config.add("archon", v2(fake.url)).status).toBe(201);
    const result = await config.test("archon", { signal: new AbortController().signal });
    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, total: 2, v2: { server: { name: "fake-v2" }, extensions: expect.arrayContaining(["io.modelcontextprotocol/tasks"]), events: ["workflow_run.status_changed"] } },
    });
    expect(legacy).not.toHaveBeenCalled();
    expect(fake.requests[0]?.headers.authorization).toBe("Bearer test-key");
  });

  it("answers an address nobody listens on with one plain line", async () => {
    const { config } = fixture();
    config.add("old", v2("http://127.0.0.1:9/mcp"));
    const result = await config.test("old", { signal: new AbortController().signal });
    expect(result).toMatchObject({ status: 200, body: { ok: false } });
    const error = (result as unknown as { body: { error: string } }).body.error;
    expect(error).not.toMatch(/\n|Error:|\bat \S+:\d+/);
  });
});

describe("a v2 connection and each person's own connection", () => {
  it("refuses a v2 entry for a name each person connects", () => {
    const { config, cfg } = fixture(["archon"]);
    expect(config.add("archon", { ...v2("https://archon.example.com/mcp"), headers: {} } as StoredMcpServer)).toMatchObject({ status: 400, error: expect.stringContaining("each person cannot connect their own") });
    expect(cfg.mcpServers).toEqual({});
  });
});
