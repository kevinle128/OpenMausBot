import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic.ts";
import { parseJson } from "../schema.ts";
import { configVersion, parseOrchestratorConfig } from "./config.ts";
import type { ConnectorDefinition } from "./ports.ts";
import type { JsonValue } from "./types.ts";

export interface ConnectorPatch {
  enabled?: boolean;
  /** Replaces the instance's settings; the connector's own schema checks it. */
  settings?: Record<string, JsonValue>;
  /** The Vault name of the secret. Only the name is ever written, never a value. */
  secretName?: string;
}

export type ConnectorWrite =
  | { ok: true; version: string }
  | { ok: false; reason: "unknown" | "invalid"; error: string };

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

const isRecord = (value: unknown): value is Record<string, JsonValue> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (error: string): ConnectorWrite => ({ ok: false, reason: "invalid", error });

/**
 * Changes one connector instance in the config file and writes the whole document atomically (owner-only).
 * The file is validated before and after the change; a broken file is never overwritten, and a refused change leaves it as it was.
 */
export function updateConnectorInstance(path: string, connectors: readonly ConnectorDefinition[], id: string, patch: ConnectorPatch): ConnectorWrite {
  if (patch.secretName !== undefined && !SECRET_NAME.test(patch.secretName)) return invalid("secretName must be upper-case letters, digits and underscores, starting with a letter (3 to 64 characters)");

  let text = "{}";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return invalid(`fix the config file first: it cannot be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
  }
  let document: unknown;
  try {
    document = parseJson(text);
  } catch {
    return invalid("fix the config file first: it is not valid JSON");
  }
  if (!isRecord(document)) return invalid("fix the config file first: it must be a JSON object");
  const before = parseOrchestratorConfig(text, connectors);
  if (!before.ok) return invalid(`fix the config file first: ${before.error}`);

  // The effective config lists the default instances too, so an id that is only a definition's default is found there.
  const effective = Object.hasOwn(before.config.connectors, id) ? before.config.connectors[id] : undefined;
  if (!effective) return { ok: false, reason: "unknown", error: `${id} is not a configured connector` };

  const written = isRecord(document.connectors) ? document.connectors : {};
  const current = isRecord(written[id]) ? written[id] : { use: effective.use };
  const next: Record<string, JsonValue> = { ...current };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.settings !== undefined) next.settings = patch.settings;
  if (patch.secretName !== undefined) next.secretName = patch.secretName;
  const updated = JSON.stringify({ ...document, connectors: { ...written, [id]: next } }, null, 2) + "\n";

  const after = parseOrchestratorConfig(updated, connectors);
  if (!after.ok) return invalid(after.error);
  writeFileAtomic(path, updated, { mode: 0o600 });
  return { ok: true, version: configVersion(after.config) };
}
