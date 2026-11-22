import { serverVersion } from "../environment.ts";
import { createEventLayer } from "./events.ts";
import { CLIENT_CAPABILITIES, MCP_V2_REVISION, type RpcContext } from "./rpc.ts";
import { anyResultSchema } from "./schemas.ts";
import { createTaskLayer } from "./tasks.ts";
import { McpV2ProtocolError, type McpV2Connection, type McpV2Spec } from "./types.ts";

export interface OpenMcpV2Options {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  clientInfo?: { name: string; version: string };
}

const NOT_V2 = "the server does not speak MCP 2026-07-28";
const NEGOTIATION_CODES = new Set(["ERA_NEGOTIATION_FAILED", "UNSUPPORTED_PROTOCOL_VERSION"]);
const NEGOTIATION_RPC_CODES = new Set([-32601, -32602, -32022]);

function isNegotiationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = Reflect.get(error, "code");
  if (typeof code === "string") return NEGOTIATION_CODES.has(code);
  return typeof code === "number" && NEGOTIATION_RPC_CODES.has(code);
}

/** Connects pinned to 2026-07-28 and never falls back, so a legacy-only server fails here instead of being used wrongly. */
export async function openMcpV2(spec: McpV2Spec, options: OpenMcpV2Options = {}): Promise<McpV2Connection> {
  const sdk = await import("@modelcontextprotocol/client");
  const clientInfo = options.clientInfo ?? { name: "openmausbot", version: serverVersion() };
  const url = new URL(spec.url);
  const client = new sdk.Client(clientInfo, {
    versionNegotiation: { mode: { pin: MCP_V2_REVISION } },
    capabilities: CLIENT_CAPABILITIES,
  });
  const transport = new sdk.StreamableHTTPClientTransport(url, {
    requestInit: { headers: spec.headers },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  try {
    await client.connect(transport, options.signal ? { signal: options.signal } : undefined);
  } catch (error) {
    await client.close().catch(() => undefined);
    if (isNegotiationFailure(error)) throw new McpV2ProtocolError(NOT_V2, { cause: error });
    throw error;
  }
  if (client.getProtocolEra() !== "modern") {
    await client.close().catch(() => undefined);
    throw new McpV2ProtocolError(NOT_V2);
  }

  const rpc: RpcContext = { url, headers: spec.headers, fetch: options.fetch ?? fetch, clientInfo };
  const tasks = createTaskLayer((method, params) => client.request({ method, params }, anyResultSchema), rpc);
  const events = createEventLayer(rpc);
  const identity = client.getServerVersion();

  return {
    server: {
      name: identity?.name ?? url.host,
      version: identity?.version ?? null,
      extensions: Object.keys(client.getServerCapabilities()?.extensions ?? {}),
    },
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      }));
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      return {
        content: result.content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      };
    },
    ...tasks,
    ...events,
    close: () => client.close(),
  };
}
