import { REMOTE_PROBE_TIMEOUT_MS, redactConfiguredValues, type McpProbeResult } from "../mcp-probe.ts";
import { openMcpV2 } from "./client.ts";
import { EVENTS_EXTENSION } from "./rpc.ts";
import { McpV2ProtocolError, McpV2RpcError, type McpV2Spec } from "./types.ts";

const MAX_TOOLS = 100;
const MAX_DESCRIPTION = 200;
const MAX_NAME = 200;
const MAX_LISTED = 50;
const SHAPE_FIELDS = ["resultType", "ttlMs", "cacheScope"] as const;

export interface McpV2ProbeDetails {
  server: { name: string; version: string | null };
  extensions: string[];
  events: string[];
}

export type McpV2ProbeResult = McpProbeResult | (Extract<McpProbeResult, { ok: true }> & { v2: McpV2ProbeDetails });

export interface McpV2ProbeOptions {
  timeoutMs?: number;
  open?: typeof openMcpV2;
}

function chain(error: unknown): Error[] {
  const out: Error[] = [];
  for (let current = error; current instanceof Error && out.length < 5; current = current.cause) out.push(current);
  return out;
}

function httpStatus(error: unknown): number | null {
  for (const link of chain(error)) {
    const status = Reflect.get(link, "status") ?? Reflect.get(link, "statusCode");
    if (typeof status === "number") return status;
  }
  return null;
}

function hasCode(error: unknown, code: string): boolean {
  return chain(error).some((link) => Reflect.get(link, "code") === code);
}

/** One line a person can act on: never the SDK's own message, which can hold a schema dump. */
export function describeMcpV2Failure(error: unknown): Extract<McpProbeResult, { ok: false }> {
  const status = httpStatus(error);
  if (status === 401 || status === 403) {
    return { ok: false, error: `The server didn't accept the keys (HTTP ${status}). Check the header values.`, reason: "keys", status };
  }
  if (hasCode(error, "INVALID_RESULT")) {
    const text = chain(error).map((link) => link.message).join(" ");
    const found = SHAPE_FIELDS.filter((field) => text.includes(field));
    return {
      ok: false,
      error: `The server answered, but not the way MCP 2026-07-28 requires${found.length ? ` (${found.join(", ")} is missing or invalid)` : ""}. Ask the server's maker to fix it, or choose Standard if it is a regular MCP server.`,
    };
  }
  if (status !== null && status >= 500) {
    return { ok: false, error: `The server answered HTTP ${status}. Check the address and headers.`, reason: "unreachable", status };
  }
  if (error instanceof McpV2ProtocolError && !chain(error).some((link) => link instanceof TypeError)) {
    return { ok: false, error: "This server does not speak MCP 2026-07-28. Choose Standard for it, or check the address." };
  }
  if (error instanceof McpV2RpcError && status !== null) {
    return { ok: false, error: `The server answered HTTP ${status}. Check the address and headers.` };
  }
  return { ok: false, error: "Could not reach this address. Check the URL and your network.", reason: "unreachable" };
}

/** The Test button for a v2 connection: connect pinned to 2026-07-28, list tools and events, and close. */
export async function probeMcpV2(spec: McpV2Spec, signal: AbortSignal, options: McpV2ProbeOptions = {}): Promise<McpV2ProbeResult> {
  if (signal.aborted) return { ok: false, error: "Connection test was cancelled." };
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REMOTE_PROBE_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  const bound: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, combined]) : combined });
  let connection: Awaited<ReturnType<typeof openMcpV2>> | undefined;
  try {
    connection = await (options.open ?? openMcpV2)(spec, { signal: combined, fetch: bound });
    const tools = await connection.listTools();
    const events = connection.server.extensions.includes(EVENTS_EXTENSION) ? await connection.listEvents().catch(() => []) : [];
    // Security: bounded and redacted, as for a legacy test: a careless server may echo a header value back.
    const shown = (value: string, max = MAX_NAME) => redactConfiguredValues(value, spec.headers ?? {}).slice(0, max);
    const { name: serverName, version } = connection.server;
    return {
      ok: true,
      tools: tools.slice(0, MAX_TOOLS).map((tool) => ({ name: shown(tool.name), ...(tool.description ? { description: shown(tool.description, MAX_DESCRIPTION) } : {}) })),
      total: tools.length,
      v2: {
        server: { name: shown(serverName), version: version === null ? null : shown(version) },
        extensions: connection.server.extensions.slice(0, MAX_LISTED).map((extension) => shown(extension)),
        events: events.slice(0, MAX_LISTED).map((event) => shown(event.name)),
      },
    };
  } catch (error) {
    if (signal.aborted) return { ok: false, error: "Connection test was cancelled." };
    if (timeout.aborted) return { ok: false, error: "The server did not answer in time.", reason: "timeout" };
    return describeMcpV2Failure(error);
  } finally {
    await connection?.close().catch(() => undefined);
  }
}
