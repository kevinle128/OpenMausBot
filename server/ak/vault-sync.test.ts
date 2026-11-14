import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { VaultSecret } from "../../shared/vault.ts";
import { AkError, type AkCli } from "./cli.ts";
import { createAkGuard } from "./guard.ts";
import { AK_SYNC_LEDGER_FILE, isAkRef, startVaultSync, type VaultSync } from "./vault-sync.ts";

const BOT = "paseo-gatekeeper";
const VALUE = "value-should-never-be-logged-1";

interface Row extends VaultSecret {
  value: string;
}

function fakeVault(rows: Row[] = []) {
  const vault = {
    version: 1,
    rows,
    listSecrets: () => vault.rows.map(({ value: _value, ...secret }) => secret),
    secret: (id: string) => vault.rows.find((row) => row.id === id) ?? null,
    touch() {
      vault.version += 1;
    },
  };
  return vault;
}

const secret = (id: string, name: string, extra: Partial<Row> = {}): Row => ({
  id, name, value: `${VALUE}-${id}`, source: "settings", bots: [BOT], createdAt: 1, updatedAt: 1, ...extra,
});

function fakeCli(initial: string[] = []) {
  const refs = new Map(initial.map((ref) => [ref, "existing"]));
  const calls: string[] = [];
  const values: Array<[string, string]> = [];
  const failWith: { error: Error | null } = { error: null };
  /** Refs `ak` refuses with exit 2, as for a name it does not accept. */
  const refuse = new Set<string>();
  const cli: Pick<AkCli, "list" | "set" | "rotate" | "delete"> = {
    async list() {
      if (failWith.error) throw failWith.error;
      return [...refs.keys()].map((ref) => ({ ref }));
    },
    async set(ref, value) {
      calls.push(`set ${ref}`);
      values.push([ref, value]);
      if (refuse.has(ref)) throw new AkError("invalid", 2, "invalid ref");
      if (refs.has(ref)) throw new AkError("exists", 4, "already exists");
      refs.set(ref, value);
    },
    async rotate(ref, value) {
      calls.push(`rotate ${ref}`);
      values.push([ref, value]);
      refs.set(ref, value);
    },
    async delete(ref) {
      calls.push(`delete ${ref}`);
      if (!refs.delete(ref)) throw new AkError("no-such-ref", 3, "no such ref");
    },
  };
  return { cli, refs, calls, values, failWith, refuse };
}

let dirs: string[] = [];
let syncs: VaultSync[] = [];
afterEach(() => {
  for (const sync of syncs) sync.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  syncs = [];
});

function setup(rows: Row[], akRefs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "ak-sync-"));
  dirs.push(dir);
  const vault = fakeVault(rows);
  const ak = fakeCli(akRefs);
  const logs: string[] = [];
  const guard = createAkGuard((line) => logs.push(line));
  const start = () => {
    const sync = startVaultSync({ vault, cli: ak.cli, guard, dataDir: dir, botId: BOT, log: (line) => logs.push(line) });
    syncs.push(sync);
    return sync;
  };
  return { dir, vault, ak, logs, guard, start, ledger: () => readFileSync(join(dir, AK_SYNC_LEDGER_FILE), "utf8") };
}

describe("isAkRef", () => {
  it("accepts ordinary names and refuses what ak refuses", () => {
    expect(isAkRef("Stripe secret key")).toBe(true);
    expect(isAkRef("DB_PASSWORD")).toBe(true);
    for (const bad of ["", "a/b", "-flag", "a\nb", "a\u0000b", "a‮b", "a​b", " lead", "x".repeat(200)]) expect(isAkRef(bad)).toBe(false);
  });
});

describe("Vault to ak sync", () => {
  it("adds a secret kept to the Paseo bot, sending the value on stdin only", async () => {
    const t = setup([secret("a", "API_KEY"), secret("b", "OTHER", { bots: "all" }), secret("c", "OTHER_BOT", { bots: ["someone-else"] })]);
    const sync = t.start();
    await sync.reconcile();
    expect(t.ak.calls).toEqual(["set API_KEY"]);
    expect(t.ak.values).toEqual([["API_KEY", `${VALUE}-a`]]);
    expect(sync.owns("API_KEY")).toBe(true);
    expect(sync.owns("OTHER")).toBe(false);
    expect(t.logs.join("\n")).not.toContain(VALUE);
    expect(t.ledger()).not.toContain(VALUE);
  });

  it("rotates a changed value and deletes a removed or out-of-scope secret, only for refs it wrote", async () => {
    const t = setup([secret("a", "A"), secret("b", "B")], ["USER_OWN"]);
    const sync = t.start();
    await sync.reconcile();
    t.ak.calls.length = 0;

    t.vault.rows[0] = { ...t.vault.rows[0]!, value: "new", updatedAt: 2 };
    t.vault.rows[1] = { ...t.vault.rows[1]!, bots: ["someone-else"] };
    t.vault.touch();
    await sync.reconcile();
    expect(t.ak.calls).toEqual(["delete B", "rotate A"]);
    expect(t.ak.refs.get("A")).toBe("new");
    expect(t.ak.refs.has("USER_OWN")).toBe(true);
    expect(sync.owns("B")).toBe(false);

    t.ak.calls.length = 0;
    t.vault.rows = [];
    t.vault.touch();
    await sync.reconcile();
    expect(t.ak.calls).toEqual(["delete A"]);
    expect([...t.ak.refs.keys()]).toEqual(["USER_OWN"]);
  });

  it("skips a secret ak refuses, warns once, and still copies the others without retrying", async () => {
    const t = setup([secret("a", "REFUSED"), secret("b", "GOOD")]);
    t.ak.refuse.add("REFUSED");
    const sync = t.start();
    await sync.reconcile();
    expect(t.ak.calls).toEqual(["set REFUSED", "set GOOD"]);
    expect(sync.owns("GOOD")).toBe(true);
    expect(sync.owns("REFUSED")).toBe(false);
    t.vault.touch();
    await sync.reconcile();
    await sync.reconcile();
    expect(t.logs.filter((line) => line.includes("ak refused \"REFUSED\""))).toHaveLength(1);
    expect(t.logs.join("\n")).not.toContain(VALUE);
    // The pass finished cleanly, so the poll is not asking ak again for a ref that cannot be written.
    expect(t.ak.calls.filter((call) => call === "set REFUSED")).toHaveLength(1);
  });

  it("still stops and reports when ak refuses to run under an agent in the middle of the pass", async () => {
    const t = setup([secret("a", "A"), secret("b", "B")]);
    const sync = t.start();
    t.ak.cli.set = async () => {
      throw new AkError("agent-above-process", 6, "refused");
    };
    await sync.reconcile();
    expect(t.guard.blocked).toBe(true);
  });

  it("follows a rename by deleting the old ref and setting the new one", async () => {
    const t = setup([secret("a", "OLD")]);
    const sync = t.start();
    await sync.reconcile();
    t.ak.calls.length = 0;
    t.vault.rows[0] = { ...t.vault.rows[0]!, name: "NEW", updatedAt: 2 };
    t.vault.touch();
    await sync.reconcile();
    expect(t.ak.calls).toEqual(["delete OLD", "set NEW"]);
  });

  it("leaves an ak secret of the same name that it did not write alone, and never claims it", async () => {
    const t = setup([secret("a", "TAKEN")], ["TAKEN"]);
    const sync = t.start();
    await sync.reconcile();
    expect(t.ak.calls).toEqual(["set TAKEN"]);
    expect(t.ak.refs.get("TAKEN")).toBe("existing");
    expect(sync.owns("TAKEN")).toBe(false);
    t.vault.rows = [];
    t.vault.touch();
    await sync.reconcile();
    expect(t.ak.refs.has("TAKEN")).toBe(true);
    expect(t.logs.join("\n")).not.toContain(VALUE);
  });

  it("skips a name that is not a valid ref and logs the name only", async () => {
    const t = setup([secret("a", "bad/name"), secret("b", "GOOD")]);
    await t.start().reconcile();
    expect(t.ak.calls).toEqual(["set GOOD"]);
    expect(t.logs.join("\n")).toContain("bad/name");
    expect(t.logs.join("\n")).not.toContain(VALUE);
  });

  it("uses the newest of two secrets with one name", async () => {
    const t = setup([secret("a", "Same name", { updatedAt: 1 }), secret("b", "same-name", { updatedAt: 5 })]);
    await t.start().reconcile();
    expect(t.ak.calls).toEqual(["set same-name"]);
  });

  it("sets what is missing in ak at start and remembers ledger rows across restarts", async () => {
    const t = setup([secret("a", "A")]);
    await t.start().reconcile();
    t.ak.refs.delete("A");
    t.ak.calls.length = 0;
    const again = t.start();
    await again.reconcile();
    expect(t.ak.calls).toEqual(["set A"]);
    expect(again.owns("A")).toBe(true);
    const third = t.start();
    t.ak.calls.length = 0;
    t.vault.rows = [];
    t.vault.touch();
    await third.reconcile();
    expect(t.ak.calls).toEqual(["delete A"]);
  });

  it("does not call ak again while nothing in scope changed", async () => {
    const t = setup([secret("a", "A")]);
    const sync = t.start();
    await sync.reconcile();
    let listed = 0;
    const list = t.ak.cli.list;
    t.ak.cli.list = async () => (listed++, list());
    t.vault.touch();
    await sync.reconcile();
    expect(listed).toBe(0);
  });

  it("stops everything on a refusal from ak and logs it once", async () => {
    const t = setup([secret("a", "A")]);
    t.ak.failWith.error = new AkError("agent-above-process", 6, "refused");
    const sync = t.start();
    await sync.reconcile();
    await sync.reconcile();
    expect(t.guard.blocked).toBe(true);
    expect(t.logs.filter((line) => line.includes("refused to run"))).toHaveLength(1);
    expect(t.ak.calls).toEqual([]);
  });

  it("keeps working after another kind of failure and logs the failure without a value", async () => {
    const t = setup([secret("a", "A")]);
    t.ak.failWith.error = new AkError("backend", 5, "keychain locked");
    const sync = t.start();
    await sync.reconcile();
    expect(t.logs.join("\n")).toContain("keychain locked");
    expect(t.guard.blocked).toBe(false);
    expect(existsSync(join(t.dir, AK_SYNC_LEDGER_FILE))).toBe(false);
  });
});
