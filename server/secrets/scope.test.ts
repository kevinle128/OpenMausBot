import { describe, expect, it } from "vitest";

import { PASEO_BOT_ID } from "../paseo/gatekeeper.ts";
import { isScopedRef, paseoScopedSecrets } from "./scope.ts";

const secret = (id: string, name: string, extra: { updatedAt?: number; bots?: "all" | string[] } = {}) => ({
  id, name, source: "settings" as const, createdAt: 1, updatedAt: extra.updatedAt ?? 1, bots: extra.bots ?? [PASEO_BOT_ID],
});

function vault(rows: Array<ReturnType<typeof secret>>) {
  return { listSecrets: () => rows };
}

describe("isScopedRef", () => {
  it("accepts ordinary names and refuses a slash, a leading dash, controls and a long name", () => {
    expect(isScopedRef("Stripe secret key")).toBe(true);
    expect(isScopedRef("DB_PASSWORD")).toBe(true);
    for (const bad of ["", "a/b", "-flag", "a\nb", "a\u0000b", "a‮b", "a​b", " lead", "x".repeat(200)]) expect(isScopedRef(bad)).toBe(false);
  });
});

describe("paseoScopedSecrets", () => {
  it("keeps a secret shared with every bot or naming the Paseo bot", () => {
    const rows = [secret("a", "API_KEY"), secret("b", "SHARED", { bots: "all" }), secret("c", "OTHER", { bots: ["someone-else"] })];
    expect([...paseoScopedSecrets(vault(rows), PASEO_BOT_ID).keys()].sort()).toEqual(["API_KEY", "SHARED"]);
  });

  it("skips a name that is not a valid ref and uses the newest of two with one name", () => {
    const skipped: string[] = [];
    const rows = [
      secret("a", "bad/name"),
      secret("b", "Same name", { updatedAt: 1 }),
      secret("c", "same-name", { updatedAt: 5 }),
    ];
    const scoped = paseoScopedSecrets(vault(rows), PASEO_BOT_ID, (name) => skipped.push(name));
    expect([...scoped.values()].map((entry) => entry.ref)).toEqual(["same-name"]);
    expect(skipped).toEqual(["bad/name"]);
  });
});
