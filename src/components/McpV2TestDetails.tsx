import { t } from "@/lib/i18n";

export interface McpV2TestInfo {
  server: { name: string; version: string | null };
  extensions: string[];
  events: string[];
}

const list = (items: readonly string[]) => items.join(", ");

/** What a passing test of an MCP v2 connection found: who answered, which extensions it offers, and its events. */
export function McpV2TestDetails({ v2 }: { v2: McpV2TestInfo }) {
  return (
    <ul data-mcp-v2-details className="mt-1.5 basis-full space-y-0.5 ps-6 text-[12px]">
      <li>{t("mcp.check.v2Server", { name: v2.server.name, version: v2.server.version ? ` ${v2.server.version}` : "" })}</li>
      <li>{v2.extensions.length ? t("mcp.check.v2Extensions", { list: list(v2.extensions) }) : t("mcp.check.v2NoExtensions")}</li>
      <li>{v2.events.length ? t("mcp.check.v2Events", { list: list(v2.events) }) : t("mcp.check.v2NoEvents")}</li>
    </ul>
  );
}

/** The tool count of a connection no bot uses: the chat tool budget does not apply to it. */
export function v2ConnectedLabel(result: { tools?: unknown[]; total?: number }): string {
  const count = Math.max(result.total ?? 0, result.tools?.length ?? 0);
  if (!count) return t("mcp.check.connectedNone");
  return count === 1 ? t("mcp.check.connectedOne") : t("mcp.check.connectedMany", { count });
}
