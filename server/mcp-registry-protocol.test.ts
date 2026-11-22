import { describe, expect, it } from "vitest";

import { customMcpServers, type AppConfig } from "./config.ts";
import { listMcpServers, parseMcpServerMutation, parseStoredMcpServer } from "./mcp-registry.ts";

const config = (mcpServers: Record<string, unknown>) => ({ mcpServers }) as unknown as AppConfig;
const v2Entry = { type: "http", protocol: "v2", url: "https://archon.example/mcp", headers: { Authorization: "Bearer fixture-token" } };

describe("the MCP protocol of a remote connection", () => {
  it("reads an entry without a protocol as legacy", () => {
    const stored = parseStoredMcpServer("docs", { url: "https://docs.example/mcp" });
    expect(stored).toMatchObject({ ok: true });
    if (!stored.ok) throw new Error("unreachable");
    expect("protocol" in stored.server).toBe(false);
    expect(listMcpServers({ docs: { url: "https://docs.example/mcp" } })).toEqual([expect.objectContaining({ name: "docs", protocol: "legacy" })]);
    expect(listMcpServers({ docs: { url: "https://docs.example/mcp" } })[0]).not.toHaveProperty("ombOnly");
  });

  it("keeps every harness's server list unchanged for a config without v2 entries", () => {
    const servers = {
      web: { type: "http", url: "https://web.example/mcp", headers: { Authorization: "Bearer a" } },
      old: { type: "sse", url: "https://old.example/sse", headers: {} },
      notes: { command: "npx", args: ["-y", "notes-mcp"], env: { TOKEN: "t" } },
      lent: { url: "https://127.0.0.1:4000/mcp", runsOn: { environmentId: "env-1", label: "Studio Mac" } },
    };
    expect(customMcpServers(config(servers))).toEqual({
      web: { type: "http", url: "https://web.example/mcp", headers: { Authorization: "Bearer a" } },
      old: { type: "sse", url: "https://old.example/sse", headers: {} },
      notes: { command: "npx", args: ["-y", "notes-mcp"], env: { TOKEN: "t" } },
    });
    expect(listMcpServers(servers).filter((server) => "url" in server).map((server) => "protocol" in server && server.protocol)).toEqual(["legacy", "legacy", "legacy"]);
  });

  it("stores and lists a v2 entry as used by OMB only", () => {
    const added = parseMcpServerMutation("archon", v2Entry);
    expect(added).toMatchObject({ ok: true, server: { protocol: "v2", type: "http", apps: false } });
    if (!added.ok) throw new Error("unreachable");
    expect(parseStoredMcpServer("archon", added.server)).toMatchObject({ ok: true, server: { protocol: "v2" } });
    const [listed] = listMcpServers({ archon: added.server });
    expect(listed).toMatchObject({ name: "archon", protocol: "v2", ombOnly: true, apps: false, headerKeys: ["Authorization"] });
    expect(JSON.stringify(listed)).not.toContain("fixture-token");
  });

  it("keeps a v2 entry's protocol through an edit that does not name it", () => {
    const added = parseMcpServerMutation("archon", v2Entry);
    if (!added.ok) throw new Error("unreachable");
    const edited = parseMcpServerMutation("archon", { url: "https://archon.example/mcp", headers: {} }, added.server);
    expect(edited).toMatchObject({ ok: true, server: { protocol: "v2" } });
    const switched = parseMcpServerMutation("archon", { url: "https://archon.example/mcp", protocol: "legacy" }, added.server);
    expect(switched).toMatchObject({ ok: true });
    if (!switched.ok) throw new Error("unreachable");
    expect("protocol" in switched.server).toBe(false);
  });

  it("never hands a v2 entry to a harness", () => {
    const servers = { archon: { ...v2Entry, enabled: true }, web: { url: "https://web.example/mcp" } };
    expect(Object.keys(customMcpServers(config(servers)))).toEqual(["web"]);
    expect(Object.keys(customMcpServers(config(servers), ["archon", "web"], "ada"))).toEqual(["web"]);
    expect(Object.keys(customMcpServers(config(servers), ["archon"]))).toEqual([]);
  });

  it("refuses v2 with the SSE transport, with OAuth, with a lent computer and on a stdio entry", () => {
    const sse = parseMcpServerMutation("archon", { ...v2Entry, type: "sse" });
    expect(sse).toEqual({ ok: false, error: "An MCP v2 connection uses Streamable HTTP; SSE is a legacy transport." });
    const oauth = parseMcpServerMutation("archon", { ...v2Entry, oauth: { clientId: "app" } });
    expect(oauth).toMatchObject({ ok: false, error: expect.stringContaining("OAuth") });
    const lent = parseMcpServerMutation("archon", { ...v2Entry, runsOn: { environmentId: "env-1", label: "Studio Mac" } });
    expect(lent).toMatchObject({ ok: false, error: expect.stringContaining("lent computer") });
    expect(parseMcpServerMutation("notes", { command: "npx", protocol: "v2" })).toMatchObject({ ok: false });
    expect(parseStoredMcpServer("notes", { command: "npx", protocol: "v2" })).toMatchObject({ ok: false });
  });
});
