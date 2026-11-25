import { describe, expect, it } from "vitest";

import { isScopedRef, paseoScopedSecrets } from "./scope.ts";

const secret = (id: string, name: string, extra: { updatedAt?: number; bots?: "all" | string[] } = {}) => ({
  id, name, source: "settings" as const, createdAt: 1, updatedAt: extra.updatedAt ?? 1, bots: extra.bots ?? [],
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
  it("keeps every valid secret, including one with no bots and one named for another bot", () => {
    const rows = [
      secret("a", "API_KEY", { bots: [] }),
      secret("b", "SHARED", { bots: "all" }),
      secret("c", "OTHER", { bots: ["someone-else"] }),
    ];
    expect([...paseoScopedSecrets(vault(rows)).keys()].sort()).toEqual(["API_KEY", "OTHER", "SHARED"]);
  });

  it("skips a name that is not a valid ref, keeps the newest of one exact name, and keeps a different spelling", () => {
    const skipped: string[] = [];
    const rows = [
      secret("a", "bad/name"),
      secret("c", "API_KEY", { updatedAt: 5, bots: ["other-bot"] }),
      secret("b", "API_KEY", { updatedAt: 1, bots: [] }),
      secret("d", "api-key", { updatedAt: 9, bots: [] }),
    ];
    const scoped = paseoScopedSecrets(vault(rows), (name) => skipped.push(name));
    expect(scoped.get("API_KEY")).toMatchObject({ id: "c", ref: "API_KEY" });
    expect(scoped.get("api-key")).toMatchObject({ id: "d", ref: "api-key" });
    expect(skipped).toEqual(["bad/name", "API_KEY"]);
  });

  it("replaces an older duplicate and notifies onSkip when the newer secret appears later", () => {
    const skipped: Array<[string, string]> = [];
    const rows = [
      secret("b", "API_KEY", { updatedAt: 1, bots: [] }),
      secret("c", "API_KEY", { updatedAt: 5, bots: ["other-bot"] }),
    ];
    const scoped = paseoScopedSecrets(vault(rows), (name, why) => skipped.push([name, why]));
    expect(scoped.get("API_KEY")).toMatchObject({ id: "c", ref: "API_KEY", updatedAt: 5 });
    expect(skipped).toEqual([["API_KEY", "another secret has the same name"]]);
  });
});
