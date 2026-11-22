import { describe, expect, it } from "vitest";

import { readMcpPaste } from "./mcp-paste";

const paste = (entry: Record<string, unknown>) => readMcpPaste(JSON.stringify({ mcpServers: { archon: entry } }), []);

describe("the protocol of a pasted entry", () => {
  it("keeps protocol v2 from a pasted entry and refuses an unknown protocol", () => {
    const v2 = paste({ url: "https://archon.example.com/mcp", protocol: "v2" });
    expect(v2).toMatchObject({ ok: true, servers: [{ transport: "remote", type: "http", protocol: "v2" }] });
    expect(paste({ url: "https://archon.example.com/mcp", protocol: "v3" })).toEqual({ ok: false, error: "mcp.paste.badProtocol" });
    expect(paste({ url: "https://archon.example.com/mcp", type: "sse", protocol: "v2" })).toEqual({ ok: false, error: "mcp.paste.badProtocol" });
    const plain = paste({ url: "https://archon.example.com/mcp" });
    expect(plain).toMatchObject({ ok: true });
    if (plain?.ok) expect(plain.servers[0]).not.toHaveProperty("protocol");
  });

  it("accepts protocol legacy as the standard one and refuses v2 on a command", () => {
    const legacy = paste({ url: "https://archon.example.com/mcp", protocol: "legacy" });
    expect(legacy).toMatchObject({ ok: true });
    if (legacy?.ok) expect(legacy.servers[0]).not.toHaveProperty("protocol");
    expect(paste({ command: "npx", args: ["archon"], protocol: "v2" })).toEqual({ ok: false, error: "mcp.paste.badProtocol" });
  });
});
