import { readSseFrames } from "./sse.ts";
import { McpV2RpcError } from "./types.ts";

export const MCP_V2_REVISION = "2026-07-28";
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";

export const CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
  extensions: { [TASKS_EXTENSION]: {}, [EVENTS_EXTENSION]: {} },
};

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const NAMED_METHODS = new Set(["tools/call", "events/poll", "events/stream"]);

export interface RpcContext {
  url: URL;
  headers: Record<string, string>;
  fetch: typeof fetch;
  clientInfo: { name: string; version: string };
}

let nextId = 0;

/** Sends one request the SDK client cannot carry: it refuses a task result to `tools/call`, and it leaves out the `Mcp-Name` header that `events/*` needs. */
export async function rpcPost(
  ctx: RpcContext,
  method: string,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal; stream?: boolean } = {},
): Promise<{ id: number; response: Response }> {
  const id = ++nextId;
  const headers = new Headers(ctx.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", options.stream ? "text/event-stream" : "application/json, text/event-stream");
  headers.set("mcp-protocol-version", MCP_V2_REVISION);
  headers.set("mcp-method", method);
  const name = params.name;
  if (NAMED_METHODS.has(method) && typeof name === "string") headers.set("mcp-name", name);
  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [META_PROTOCOL_VERSION]: MCP_V2_REVISION,
        [META_CLIENT_INFO]: ctx.clientInfo,
        [META_CLIENT_CAPABILITIES]: CLIENT_CAPABILITIES,
      },
    },
  };
  const response = await ctx.fetch(ctx.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { id, response };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rpcErrorOf(value: unknown, status: number | null): McpV2RpcError | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const { code, message } = value.error;
  return new McpV2RpcError(typeof message === "string" ? message : "request failed", typeof code === "number" ? code : null, status);
}

/** The error behind a response that is not a stream: a JSON-RPC error body, else the HTTP status. */
export async function failureOf(response: Response): Promise<McpV2RpcError> {
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return rpcErrorOf(parsed, response.status) ?? new McpV2RpcError(`the server answered HTTP ${response.status}`, null, response.status);
}

function resultOf(message: unknown, status: number): Record<string, unknown> {
  const failure = rpcErrorOf(message, status);
  if (failure) throw failure;
  if (!isRecord(message) || !isRecord(message.result)) throw new McpV2RpcError("the server answered without a result", null, status);
  return message.result;
}

/** One request, one result. The server may answer with JSON or with an SSE stream that ends in the response. */
export async function rpcCall(
  ctx: RpcContext,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const { id, response } = await rpcPost(ctx, method, params, signal ? { signal } : {});
  if (!response.ok) throw await failureOf(response);
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream") && response.body) {
    for await (const frame of readSseFrames(response.body)) {
      let message: unknown;
      try {
        message = JSON.parse(frame.data);
      } catch {
        continue;
      }
      if (isRecord(message) && message.id === id) return resultOf(message, response.status);
    }
    throw new McpV2RpcError("the stream ended without a response", null, response.status);
  }
  return resultOf(await response.json().catch(() => null), response.status);
}
