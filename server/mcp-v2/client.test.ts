import { afterEach, expect, it } from "vitest";
import { openMcpV2 } from "./client.ts";
import { startFakeV2Server, type FakeV2Server } from "./testing/fake-v2-server.ts";
import { McpV2ProtocolError } from "./types.ts";

let fake: FakeV2Server | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

it("connects to a 2026-07-28 server and reports its name and extensions", async () => {
  fake = await startFakeV2Server();
  const connection = await openMcpV2({ url: fake.url, headers: { authorization: "Bearer test-key" } });
  try {
    expect(connection.server).toEqual({
      name: "fake-v2",
      version: "2.0.1",
      extensions: ["io.modelcontextprotocol/tasks", "io.modelcontextprotocol/events"],
    });
    expect((await connection.listTools()).map((tool) => tool.name)).toEqual(["run_workflow", "get_run"]);
    expect(fake.requests[0]?.headers.authorization).toBe("Bearer test-key");
    expect(fake.requests[0]?.headers["mcp-protocol-version"]).toBe("2026-07-28");
  } finally {
    await connection.close();
  }
});

it("fails with a protocol error against a server that only speaks the 2025 handshake", async () => {
  fake = await startFakeV2Server({ mode: "legacy" });
  await expect(openMcpV2({ url: fake.url, headers: {} })).rejects.toBeInstanceOf(McpV2ProtocolError);
});

it("declares the tasks and events extensions and form elicitation on every request", async () => {
  fake = await startFakeV2Server();
  const connection = await openMcpV2({ url: fake.url, headers: {} });
  try {
    await connection.listTools();
    await connection.callToolAsTask("run_workflow", {});
    await connection.getTask("run-1");
    await connection.listEvents();
    await connection.pollEvents({ name: "workflow_run.status_changed", cursor: null });
    const declared = fake.requests.map((request) => request.clientCapabilities);
    expect(declared.length).toBeGreaterThanOrEqual(6);
    for (const capabilities of declared) {
      expect(capabilities).toEqual({
        elicitation: { form: {} },
        extensions: { "io.modelcontextprotocol/tasks": {}, "io.modelcontextprotocol/events": {} },
      });
    }
  } finally {
    await connection.close();
  }
});
