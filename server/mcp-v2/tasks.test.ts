import { afterEach, beforeEach, expect, it } from "vitest";
import { openMcpV2 } from "./client.ts";
import { startFakeV2Server, type FakeV2Server } from "./testing/fake-v2-server.ts";
import type { McpV2Connection } from "./types.ts";

let fake: FakeV2Server;
let connection: McpV2Connection;

const approval = {
  method: "elicitation/create",
  params: { mode: "form", message: "Approve?", requestedSchema: { type: "object", properties: { decision: { type: "string" } } } },
};

beforeEach(async () => {
  fake = await startFakeV2Server();
  connection = await openMcpV2({ url: fake.url, headers: {} });
});

afterEach(async () => {
  await connection.close();
  await fake.close();
});

it("gets a task back from a tool call when the server creates one", async () => {
  const outcome = await connection.callToolAsTask("run_workflow", { workflow: "w" });
  expect(outcome).toMatchObject({ task: { taskId: "run-1", status: "working", ttlMs: 60_000 } });
  const call = fake.requests.find((request) => request.method === "tools/call");
  expect(call?.headers["mcp-name"]).toBe("run_workflow");
  expect(call?.params.arguments).toEqual({ workflow: "w" });
});

it("returns the plain result when the server does not create a task", async () => {
  const outcome = await connection.callToolAsTask("get_run", {});
  expect(outcome).toMatchObject({ result: { structuredContent: { run_id: "run-1" } } });
});

it("follows a task from working to input required to completed", async () => {
  await connection.callToolAsTask("run_workflow", {});
  expect(await connection.getTask("run-1")).toMatchObject({ status: "working" });

  fake.setTask({ taskId: "run-1", status: "input_required", inputRequests: { "approval-gate": approval } });
  const waiting = await connection.getTask("run-1");
  expect(waiting.status).toBe("input_required");
  expect(waiting.inputRequests?.["approval-gate"]?.params.requestedSchema).toEqual(approval.params.requestedSchema);

  fake.setTask({ taskId: "run-1", status: "completed", result: { content: [{ type: "text", text: "done" }] } });
  expect(await connection.getTask("run-1")).toMatchObject({ status: "completed", result: { content: [{ type: "text", text: "done" }] } });
});

it("sends input responses under the key the server asked for", async () => {
  fake.setTask({ taskId: "run-1", status: "input_required", inputRequests: { "approval-gate": approval } });
  const answer = { action: "accept" as const, content: { decision: "approve" } };
  await connection.updateTask("run-1", { "approval-gate": answer });
  expect(fake.updates).toEqual([{ taskId: "run-1", inputResponses: { "approval-gate": answer } }]);
  expect(await connection.getTask("run-1")).toMatchObject({ status: "working", statusMessage: "answer received" });
});

it("cancels a working task", async () => {
  await connection.callToolAsTask("run_workflow", {});
  await connection.cancelTask("run-1");
  expect((await connection.getTask("run-1")).status).toBe("cancelled");
});

it("keeps fields the schema does not know", async () => {
  await connection.callToolAsTask("run_workflow", {});
  expect((await connection.getTask("run-1")).extraField).toBe("kept");
});

it("reports a JSON-RPC error for a task the server does not know", async () => {
  await expect(connection.getTask("missing")).rejects.toThrow(/Task not found/);
});
