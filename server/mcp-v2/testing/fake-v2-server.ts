import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_EVENT_NAME = "workflow_run.status_changed";
const TASKS = "io.modelcontextprotocol/tasks";
const EVENTS = "io.modelcontextprotocol/events";
const CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META = "io.modelcontextprotocol/serverInfo";

type Json = Record<string, unknown>;

export interface RecordedRequest {
  method: string;
  headers: IncomingHttpHeaders;
  params: Json;
  clientCapabilities: Json | undefined;
}

interface EventRow {
  position: number;
  eventId: string;
  timestamp: string;
  data: Json;
}

interface OpenStream {
  response: ServerResponse;
  after: number;
}

export interface FakeV2Server {
  url: string;
  requests: RecordedRequest[];
  updates: Array<{ taskId: string; inputResponses: Json }>;
  setTask(task: Json): void;
  appendEvent(data: Json): void;
  sendHeartbeat(): void;
  endStreams(): void;
  waitForStreams(count: number): Promise<void>;
  close(): Promise<void>;
}

/** "v2" speaks 2026-07-28 only and refuses `initialize`; "legacy" knows only the 2025 handshake. */
export async function startFakeV2Server(options: { mode?: "v2" | "legacy" } = {}): Promise<FakeV2Server> {
  const mode = options.mode ?? "v2";
  const requests: RecordedRequest[] = [];
  const updates: Array<{ taskId: string; inputResponses: Json }> = [];
  const tasks = new Map<string, Json>();
  const rows: EventRow[] = [];
  const streams = new Set<OpenStream>();
  const streamWaiters: Array<{ count: number; resolve: () => void }> = [];

  const cursorOf = (position: number): string => `v1:${position}`;
  const maxPosition = (): number => rows.at(-1)?.position ?? 0;
  const frame = (method: string, params: Json): string => `data: ${JSON.stringify({ jsonrpc: "2.0", method, params })}\n\n`;
  const eventParams = (row: EventRow): Json => ({
    eventId: row.eventId,
    name: FAKE_EVENT_NAME,
    timestamp: row.timestamp,
    data: row.data,
    cursor: cursorOf(row.position),
  });

  function reply(response: ServerResponse, id: unknown, result: Json): void {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", ...result } }));
  }

  function fail(response: ServerResponse, id: unknown, code: number, message: string, status = 200): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  function headerMismatch(request: RecordedRequest, name: unknown): string | null {
    if (request.headers["mcp-protocol-version"] !== "2026-07-28") return "the MCP-Protocol-Version header must be 2026-07-28";
    if (request.headers["mcp-method"] !== request.method) return "the Mcp-Method header does not name the body method";
    if (typeof name === "string" && request.headers["mcp-name"] !== name) return "the Mcp-Name header does not mirror params.name";
    return null;
  }

  function openStream(response: ServerResponse, params: Json): void {
    const cursor = params.cursor;
    const after = typeof cursor === "string" ? Number(cursor.slice(3)) : maxPosition();
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(frame("notifications/events/active", { cursor: cursorOf(after), truncated: false }));
    for (const row of rows) if (row.position > after) response.write(frame("notifications/events/event", eventParams(row)));
    const stream: OpenStream = { response, after: maxPosition() };
    streams.add(stream);
    response.on("close", () => streams.delete(stream));
    for (const waiter of streamWaiters.splice(0)) {
      if (streams.size >= waiter.count) waiter.resolve();
      else streamWaiters.push(waiter);
    }
  }

  function handle(request: RecordedRequest, response: ServerResponse, id: unknown): void {
    const { method, params } = request;
    if (mode === "legacy") {
      if (method === "initialize") {
        reply(response, id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "legacy-fake", version: "0.1.0" } });
      } else {
        fail(response, id, -32601, `Method not found: ${method}`);
      }
      return;
    }
    if (method === "initialize") return fail(response, id, -32600, "the legacy handshake is refused", 400);
    if (method === "server/discover") {
      return reply(response, id, {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, extensions: { [TASKS]: {}, [EVENTS]: {} } },
        _meta: { [SERVER_INFO_META]: { name: "fake-v2", version: "2.0.1" } },
      });
    }
    const declared = (request.clientCapabilities?.extensions as Json | undefined) ?? {};
    if (method === "tools/list") {
      return reply(response, id, {
        ttlMs: 0,
        cacheScope: "private",
        tools: [
          { name: "run_workflow", description: "Start a run", inputSchema: { type: "object" } },
          { name: "get_run", inputSchema: { type: "object" } },
        ],
      });
    }
    if (method === "tools/call") {
      if (params.name === "run_workflow" && declared[TASKS] !== undefined) {
        const task = { taskId: "run-1", status: "working", ttlMs: 60_000, pollIntervalMs: 1000, extraField: "kept" };
        tasks.set("run-1", task);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "task", ...task } }));
        return;
      }
      return reply(response, id, {
        content: [{ type: "text", text: '{"run_id":"run-1"}' }],
        structuredContent: { run_id: "run-1" },
      });
    }
    if (method === "tasks/get" || method === "tasks/update" || method === "tasks/cancel") {
      if (declared[TASKS] === undefined) return fail(response, id, -32021, "Missing required client capability");
      const taskId = String(params.taskId);
      const task = tasks.get(taskId);
      if (!task) return fail(response, id, -32602, `Task not found (${taskId})`);
      if (method === "tasks/get") return reply(response, id, task);
      if (method === "tasks/cancel") {
        if (task.status === "working") tasks.set(taskId, { ...task, status: "cancelled" });
        return reply(response, id, {});
      }
      const inputResponses = (params.inputResponses as Json | undefined) ?? {};
      updates.push({ taskId, inputResponses });
      const open = Object.keys((task.inputRequests as Json | undefined) ?? {});
      if (open.some((key) => inputResponses[key] !== undefined)) {
        const answered: Json = { ...task, status: "working", statusMessage: "answer received" };
        delete answered.inputRequests;
        tasks.set(taskId, answered);
      }
      return reply(response, id, {});
    }
    if (method === "events/list") {
      return reply(response, id, {
        events: [{ name: FAKE_EVENT_NAME, description: "A run changed status", delivery: ["poll", "push"], inputSchema: { type: "object" }, payloadSchema: { type: "object" } }],
      });
    }
    if (method === "events/poll" || method === "events/stream") {
      const mismatch = headerMismatch(request, params.name);
      if (mismatch) return fail(response, id, -32020, mismatch, 400);
      if (params.name !== FAKE_EVENT_NAME) return fail(response, id, -32023, `Unknown event: ${String(params.name)}`);
      if (method === "events/stream") return openStream(response, params);
      const cursor = params.cursor;
      if (typeof cursor !== "string") return reply(response, id, { events: [], cursor: cursorOf(maxPosition()), hasMore: false });
      const after = Number(cursor.slice(3));
      const batch = rows.filter((row) => row.position > after).map(({ eventId, timestamp, data }) => ({ eventId, name: FAKE_EVENT_NAME, timestamp, data }));
      return reply(response, id, { events: batch, cursor: cursorOf(maxPosition()), hasMore: false });
    }
    fail(response, id, -32601, `Method not found: ${method}`);
  }

  const server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      if (incoming.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; method: string; params?: Json };
      const params = body.params ?? {};
      const meta = params._meta as Json | undefined;
      const request: RecordedRequest = {
        method: body.method,
        headers: incoming.headers,
        params,
        clientCapabilities: meta?.[CAPABILITIES_META] as Json | undefined,
      };
      requests.push(request);
      if (body.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      handle(request, response, body.id);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    updates,
    setTask: (task) => void tasks.set(String(task.taskId), task),
    appendEvent(data) {
      const position = maxPosition() + 1;
      const row = { position, eventId: `run-1:${position}`, timestamp: new Date(position * 1000).toISOString(), data };
      rows.push(row);
      for (const stream of streams) stream.response.write(frame("notifications/events/event", eventParams(row)));
    },
    sendHeartbeat() {
      for (const stream of streams) stream.response.write(frame("notifications/events/heartbeat", { cursor: cursorOf(maxPosition()) }));
    },
    endStreams() {
      for (const stream of streams) stream.response.end();
    },
    waitForStreams: (count) =>
      streams.size >= count ? Promise.resolve() : new Promise<void>((resolve) => void streamWaiters.push({ count, resolve })),
    close: () =>
      new Promise<void>((resolve) => {
        for (const stream of streams) stream.response.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
