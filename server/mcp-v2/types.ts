export interface McpV2Spec {
  url: string;
  headers: Record<string, string>;
}

export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface McpInputRequest {
  method: string;
  params: { mode?: string; message?: string; requestedSchema?: Record<string, unknown>; [k: string]: unknown };
}

export interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  ttlMs?: number;
  inputRequests?: Record<string, McpInputRequest>;
  result?: unknown;
  [k: string]: unknown;
}

export type McpInputResponse = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

export interface McpEventType {
  name: string;
  description?: string;
  delivery: string[];
  inputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
}

export interface McpEvent {
  eventId: string;
  name: string;
  timestamp: string;
  data: unknown;
  cursor?: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpEventSubscription {
  name: string;
  arguments?: Record<string, unknown>;
  cursor: string | null;
}

export interface McpEventStreamRequest extends McpEventSubscription {
  signal: AbortSignal;
  onEvent(event: McpEvent): void;
  onHeartbeat?(cursor: string): void;
}

export interface McpEventStreamEnd {
  cursor: string | null;
  reason: "closed" | "aborted" | "error";
  error?: string;
}

/** What tool, task and event payloads hold is data from another program: callers frame it as data and never run it. */
export interface McpV2Connection {
  readonly server: { name: string; version: string | null; extensions: string[] };
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  callToolAsTask(name: string, args: Record<string, unknown>): Promise<{ task: McpTask } | { result: unknown }>;
  getTask(taskId: string): Promise<McpTask>;
  updateTask(taskId: string, inputResponses: Record<string, McpInputResponse>): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  listEvents(): Promise<McpEventType[]>;
  pollEvents(req: McpEventSubscription): Promise<{ events: McpEvent[]; cursor: string }>;
  streamEvents(req: McpEventStreamRequest): Promise<McpEventStreamEnd>;
  close(): Promise<void>;
}

/** The server does not speak MCP 2026-07-28. */
export class McpV2ProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "McpV2ProtocolError";
  }
}

/** The server answered a request with a JSON-RPC error or an HTTP failure. `code` is the JSON-RPC code when there is one. */
export class McpV2RpcError extends Error {
  code: number | null;
  status: number | null;
  constructor(message: string, code: number | null, status: number | null) {
    super(message);
    this.name = "McpV2RpcError";
    this.code = code;
    this.status = status;
  }
}
