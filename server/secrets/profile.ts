import { z } from "zod";

import type { SecretProfile } from "../../shared/vault.ts";

const TEXT_MAX = 1_000;
const LIST_MAX = 20;
const ITEM_MAX = 100;

const text = z.string().trim().min(1).max(TEXT_MAX);
const item = z.string().trim().min(1).max(ITEM_MAX);

const profileFields = z.object({
  description: text.optional(),
  projects: z.array(item).max(LIST_MAX).optional(),
  provider: item.optional(),
  kind: item.optional(),
  tags: z.array(item).max(LIST_MAX).optional(),
  whenToUse: text.optional(),
  whenNotToUse: text.optional(),
  sensitivity: item.optional(),
  expiresAt: z.number().int().positive().optional(),
  rotateUrl: z.string().trim().url().max(TEXT_MAX).optional(),
});

/** From disk: a field a newer release wrote is dropped and a profile that no longer parses is skipped, never failing the whole Vault file. */
export const diskProfileSchema = profileFields.optional().catch(undefined);

export type ProfileResult = { ok: true; profile: SecretProfile | undefined } | { ok: false; error: string };

/** A profile arriving from a client: unknown fields are refused, empty means none, and none of its text may contain the value. */
export function parseProfile(raw: unknown, value?: string): ProfileResult {
  if (raw === undefined || raw === null) return { ok: true, profile: undefined };
  const parsed = profileFields.strict().safeParse(raw);
  if (!parsed.success) return { ok: false, error: `profile: ${parsed.error.issues[0]?.path.join(".") || "profile"} is not valid` };
  const profile = parsed.data;
  if (value && value.length >= 8 && JSON.stringify(profile).includes(JSON.stringify(value).slice(1, -1))) {
    return { ok: false, error: "profile: its text contains the secret value" };
  }
  return { ok: true, profile: Object.keys(profile).length ? profile : undefined };
}

/** The value's public face for an agent choosing a ref: a known public prefix and the last four characters, or null when the value is short. */
const PUBLIC_PREFIXES = ["github_pat_", "sk-ant-", "sk-proj-", "sk_live_", "sk_test_", "pk_live_", "pk_test_", "rk_live_", "ghp_", "gho_", "ghs_", "ghu_", "glpat-", "xoxb-", "xoxp-", "xapp-", "AKIA", "AIza", "npm_", "sk-"];
export const HINT_MIN_LENGTH = 16;

/** The public prefix is not counted: at least HINT_MIN_LENGTH characters must follow it, so four of them shown hide the rest. */
export function valueHint(value: string): string | null {
  const prefix = PUBLIC_PREFIXES.find((one) => value.startsWith(one)) ?? "";
  const rest = Array.from(value.slice(prefix.length));
  if (rest.length < HINT_MIN_LENGTH) return null;
  return `${prefix}…${rest.slice(-4).join("")}`;
}
