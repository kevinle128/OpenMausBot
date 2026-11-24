import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic.ts";
import { parseJson } from "../schema.ts";

/**
 * Write-only secret store for event connectors (`pr-orchestrator-secrets.json`, mode 0600).
 * Values are keyed by connector id, never logged, and never returned by any route.
 */
function readMap(path: string): Record<string, string> {
  try {
    const parsed: unknown = parseJson(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function readConnectorSecret(path: string, id: string): string | null {
  const map = readMap(path);
  return Object.hasOwn(map, id) ? map[id]! : null;
}

export function writeConnectorSecret(path: string, id: string, value: string): void {
  const map = readMap(path);
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    if (!Object.hasOwn(map, id)) return;
    delete map[id];
  } else {
    map[id] = trimmed;
  }
  writeFileAtomic(path, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
}
