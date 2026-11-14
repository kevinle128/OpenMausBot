import { DEFAULT_PASEO_URL } from "./connection.ts";

export interface PaseoMcpServerEntry {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

/** The Agent MCP endpoint is on the daemon's own port. A call with no `callerAgentId` acts as the top-level caller. */
export function paseoMcpUrl(daemonUrl: string = DEFAULT_PASEO_URL): string {
  const url = new URL(daemonUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/mcp/agents";
  url.search = "";
  return url.toString();
}

/**
 * The entry for a bot's custom MCP servers. The endpoint is open on a daemon without a password. With one, it takes
 * the password as a bearer token; the local credential file is not accepted on this endpoint.
 */
export function paseoMcpServerEntry(options: { daemonUrl?: string; daemonPassword?: string } = {}): PaseoMcpServerEntry {
  return {
    type: "http",
    url: paseoMcpUrl(options.daemonUrl),
    ...(options.daemonPassword ? { headers: { Authorization: `Bearer ${options.daemonPassword}` } } : {}),
  };
}
