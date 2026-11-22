import { expect, it } from "vitest";
import { openMcpV2 } from "./client.ts";

const url = process.env.OMB_MCP_V2_LIVE_URL;

it.skipIf(!url)("discovers Archon and lists its tools and status event", async () => {
  const connection = await openMcpV2({ url: url ?? "", headers: {} });
  try {
    expect(connection.server.extensions).toEqual(expect.arrayContaining(["io.modelcontextprotocol/tasks", "io.modelcontextprotocol/events"]));
    const tools = (await connection.listTools()).map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["run_workflow", "get_run", "list_runs"]));
    const events = (await connection.listEvents()).map((event) => event.name);
    expect(events).toContain("workflow_run.status_changed");
    const { cursor } = await connection.pollEvents({ name: "workflow_run.status_changed", cursor: null });
    expect(cursor).toMatch(/^v1:\d+$/);
  } finally {
    await connection.close();
  }
});
