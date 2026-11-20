import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AUDIT_DIR, AuditLedger, type NewAuditRow } from "./audit.ts";
import { GRANTS_FILE, GrantStore } from "./grants.ts";
import { COOLDOWN_MS, PendingStore, RATE_LIMIT, RateLimiter, REQUESTS_FILE } from "./pending.ts";
import { readStateFile } from "./json-file.ts";
import { valueHint } from "./profile.ts";
import { DAY_MS, SecretsError, normalizeHost, parseTtl, type SecretScope } from "./types.ts";

const FP = `sha256:${"a".repeat(64)}`;
const OTHER = `sha256:${"b".repeat(64)}`;
const HASH = `sha256:${"c".repeat(64)}`;
const scope = (extra: Partial<SecretScope> = {}): SecretScope => ({ ref: "API_KEY", project: "default", fingerprint: FP, purpose: "deploy", ...extra });
const exec = (extra = {}) => ({ path: "/usr/bin/curl", env: "TOKEN", hash: HASH, ...extra });

let dir: string;
let clock: number;
const now = () => clock;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-secrets-"));
  clock = Date.parse("2026-11-19T10:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("grants", () => {
  const store = () => new GrantStore({ dataDir: dir, now });
  const allow = (extra = {}) => ({ ...scope(), state: "allow" as const, createdBy: "admin" as const, ...extra });

  it("matches only the full key: an empty purpose is a literal, never a wildcard", () => {
    const grants = store();
    grants.add(allow({ expiresAt: clock + DAY_MS }));
    expect(grants.match(scope()).kind).toBe("allow");
    for (const miss of [scope({ ref: "OTHER" }), scope({ project: "other" }), scope({ fingerprint: OTHER }), scope({ purpose: "" }), scope({ purpose: "other" })]) {
      expect(grants.match(miss).kind).toBe("none");
    }
    grants.add(allow({ ref: "BARE", purpose: "" }));
    expect(grants.match(scope({ ref: "BARE", purpose: "deploy" })).kind).toBe("none");
    expect(grants.match(scope({ ref: "BARE", purpose: "" })).kind).toBe("allow");
  });

  it("lets a block beat an allow, and an ordinary block refuse the exec scopes of that ref", () => {
    const grants = store();
    grants.add(allow({ exec: exec(), expiresAt: clock + DAY_MS }));
    expect(grants.match(scope({ exec: exec() })).kind).toBe("allow");
    grants.add({ ...scope(), state: "block", createdBy: "admin" });
    expect(grants.match(scope()).kind).toBe("block");
    expect(grants.match(scope({ exec: exec() })).kind).toBe("block");
    grants.add(allow({ expiresAt: clock + DAY_MS }));
    expect(grants.match(scope()).kind).toBe("block");
  });

  it("keeps ordinary and exec grants apart, and pins the program path, variable and hash", () => {
    const grants = store();
    grants.add(allow({ exec: exec(), expiresAt: clock + DAY_MS }));
    expect(grants.match(scope()).kind).toBe("none");
    for (const miss of [exec({ path: "/usr/bin/wget" }), exec({ env: "OTHER" }), exec({ hash: `sha256:${"d".repeat(64)}` })]) {
      expect(grants.match(scope({ exec: miss })).kind).toBe("none");
    }
    grants.add(allow({ expiresAt: clock + DAY_MS }));
    expect(grants.match(scope({ exec: exec({ env: "OTHER" }) })).kind).toBe("none");
  });

  it("ends a ttl grant on time, keeps a persistent one, and drops expired rows on the next write", () => {
    const grants = store();
    grants.add(allow({ expiresAt: clock + 1_000 }));
    grants.add(allow({ ref: "KEPT" }));
    clock += 1_001;
    expect(grants.match(scope()).kind).toBe("none");
    expect(grants.match(scope({ ref: "KEPT" })).kind).toBe("allow");
    grants.add(allow({ ref: "NEW" }));
    expect(JSON.parse(readFileSync(join(dir, GRANTS_FILE), "utf8")).grants.map((row: { ref: string }) => row.ref).sort()).toEqual(["KEPT", "NEW"]);
  });

  it("keeps a single-release allow beside a standing one and spends only that row", () => {
    const grants = store();
    const standing = grants.add(allow({ expiresAt: clock + DAY_MS }));
    const once = grants.add(allow({ once: true }));
    expect(grants.match(scope())).toMatchObject({ kind: "allow", grant: { id: standing.id } });
    grants.spend(standing.id);
    expect(grants.match(scope())).toMatchObject({ kind: "allow", grant: { id: once.id } });
    grants.spend(once.id);
    expect(grants.match(scope()).kind).toBe("none");
  });

  it("never drops the hosts of a scope when it is allowed again without any", () => {
    const grants = store();
    grants.add(allow({ allowHosts: ["api.example.com"], expiresAt: clock + DAY_MS }));
    const again = grants.add(allow({ expiresAt: clock + 2 * DAY_MS }));
    expect(again.allowHosts).toEqual(["api.example.com"]);
    expect(grants.list()).toHaveLength(1);
  });

  it("revokes one exact scope, an exec scope by program and variable, or everything of a fingerprint", () => {
    const grants = store();
    grants.add(allow());
    grants.add(allow({ exec: exec() }));
    grants.add(allow({ ref: "B" }));
    grants.add({ ...scope({ fingerprint: OTHER }), state: "allow", createdBy: "admin" });
    expect(grants.revoke({ fingerprint: FP, ref: "API_KEY", project: "default", purpose: "deploy" })).toBe(1);
    expect(grants.match(scope({ exec: exec() })).kind).toBe("allow");
    expect(grants.revoke({ fingerprint: FP, ref: "API_KEY", project: "default", purpose: "deploy", exec: { path: "/usr/bin/curl", env: "TOKEN" } })).toBe(1);
    expect(grants.revoke({ fingerprint: FP, all: true })).toBe(1);
    expect(grants.list()).toHaveLength(1);
  });

  it("fails closed when the grants file cannot be read, instead of treating it as empty", () => {
    writeFileSync(join(dir, GRANTS_FILE), "{not json");
    expect(() => store().match(scope())).toThrow(SecretsError);
    try {
      store().match(scope());
    } catch (error) {
      expect((error as SecretsError).exit).toBe(5);
    }
  });

  it.skipIf(process.platform === "win32")("writes the file readable by its owner only", () => {
    store().add(allow());
    expect(statSync(join(dir, GRANTS_FILE)).mode & 0o777).toBe(0o600);
  });
});

describe("pending requests", () => {
  const store = () => new PendingStore({ dataDir: dir, now });

  it("coalesces repeats of one scope into one row with a count, and keeps the first sighting", () => {
    const pending = store();
    const first = pending.record(scope(), { agentTitle: "Deploy agent" });
    clock += 5_000;
    const second = pending.record(scope(), {});
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request).toMatchObject({ id: first.request.id, count: 2, firstSeen: first.request.firstSeen, lastSeen: clock, agentTitle: "Deploy agent" });
    expect(pending.list()).toHaveLength(1);
    pending.record(scope({ exec: exec() }), {});
    pending.record(scope({ purpose: "other" }), {});
    expect(pending.list()).toHaveLength(3);
  });

  it("settles by scope and survives a restart", () => {
    const pending = store();
    const { request } = pending.record(scope(), {});
    expect(store().get(request.id)).toBeDefined();
    expect(pending.settle(scope())).toHaveLength(1);
    expect(store().list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, REQUESTS_FILE), "utf8")).version).toBe(1);
  });

  it("allows 12 requests a minute, then refuses for five minutes", () => {
    const limiter = new RateLimiter(now);
    for (let i = 0; i < RATE_LIMIT; i += 1) expect(limiter.admit(FP).ok).toBe(true);
    expect(limiter.admit(FP)).toEqual({ ok: false, retryAfterMs: COOLDOWN_MS });
    clock += COOLDOWN_MS - 1;
    expect(limiter.admit(FP).ok).toBe(false);
    expect(limiter.admit(OTHER).ok).toBe(true);
    clock += 2;
    expect(limiter.admit(FP).ok).toBe(true);
  });

  it("does not count requests spread over more than a minute", () => {
    const limiter = new RateLimiter(now);
    for (let i = 0; i < 40; i += 1) {
      expect(limiter.admit(FP).ok).toBe(true);
      clock += 6_000;
    }
  });
});

describe("audit ledger", () => {
  const row = (extra: Partial<NewAuditRow> = {}): NewAuditRow => ({
    decision: "allow", source: "adapter", ref: "API_KEY", project: "default", purpose: "deploy", fingerprint: FP, agentLabel: "", sessionId: "", context: "resolve", errorCode: "", caller: "s1", ...extra,
  });

  it("appends rows newest first, with a short fingerprint and owner-only files", () => {
    const ledger = new AuditLedger({ dataDir: dir, now });
    ledger.append(row({ ref: "A" }));
    clock += 1_000;
    ledger.append(row({ ref: "B", decision: "deny", errorCode: "approval_pending" }));
    const page = ledger.read();
    expect(page.entries.map((entry) => entry.ref)).toEqual(["B", "A"]);
    expect(page.entries[0]!.short).toBe("a".repeat(12));
    // Windows has no POSIX file modes.
    if (process.platform !== "win32") expect(statSync(join(dir, AUDIT_DIR)).mode & 0o777).toBe(0o700);
  });

  it("filters by ref, fingerprint, decision and age, and pages with a cursor", () => {
    const ledger = new AuditLedger({ dataDir: dir, now });
    for (let i = 0; i < 5; i += 1) {
      ledger.append(row({ ref: i % 2 ? "ODD" : "EVEN", fingerprint: i === 4 ? OTHER : FP }));
      clock += 60_000;
    }
    expect(ledger.read({ ref: "ODD" }).entries).toHaveLength(2);
    expect(ledger.read({ fingerprint: OTHER }).entries).toHaveLength(1);
    expect(ledger.read({ decision: "block" }).entries).toHaveLength(0);
    expect(ledger.read({ since: clock - 150_000 }).entries).toHaveLength(2);
    const first = ledger.read({ limit: 2 });
    expect(first).toMatchObject({ hasMore: true, limit: 2 });
    const second = ledger.read({ limit: 2, cursor: first.nextCursor! });
    expect(second.entries.map((entry) => entry.id)).not.toContain(first.entries[0]!.id);
    expect(second.entries).toHaveLength(2);
    expect(ledger.read({ limit: 2, cursor: second.nextCursor! })).toMatchObject({ hasMore: false });
  });

  it("throws when a row cannot be written, so no release can follow it", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, AUDIT_DIR), "a file where the folder should be");
    chmodSync(join(dir, AUDIT_DIR), 0o600);
    const ledger = new AuditLedger({ dataDir: dir, now });
    expect(() => ledger.append(row())).toThrow(SecretsError);
  });
});

describe("text helpers", () => {
  it("parses ttl words and refuses anything else", () => {
    expect(parseTtl("24h")).toBe(DAY_MS);
    expect(parseTtl("2w")).toBe(14 * DAY_MS);
    expect(parseTtl("90m")).toBe(90 * 60_000);
    for (const bad of ["", "24", "h", "-1h", "1s", "99999d", 5, undefined]) expect(parseTtl(bad)).toBeNull();
  });

  it("hints a value only when at least 16 characters follow its public prefix", () => {
    expect(valueHint("0123456789abcdef")).toBe("…cdef");
    expect(valueHint("0123456789abcde")).toBeNull();
    expect(valueHint(`github_pat_${"x".repeat(15)}`)).toBeNull();
    expect(valueHint(`sk_live_${"x".repeat(15)}`)).toBeNull();
    expect(valueHint(`github_pat_${"x".repeat(12)}WXYZ`)).toBe("github_pat_…WXYZ");
    expect(valueHint(`${"x".repeat(14)}a😀b`)).toBe("…xa😀b");
  });

  it("treats only a missing state file as empty", () => {
    expect(readStateFile(join(dir, "absent.json"), z.object({ n: z.number() }), { n: 0 })).toEqual({ n: 0 });
    mkdirSync(join(dir, "a-folder.json"));
    expect(() => readStateFile(join(dir, "a-folder.json"), z.object({ n: z.number() }), { n: 0 })).toThrow(SecretsError);
  });

  it("normalizes hosts the way an allow list names them", () => {
    expect(normalizeHost("API.Example.COM.")).toBe("api.example.com");
    expect(normalizeHost("api.example.com:443")).toBe("api.example.com");
    expect(normalizeHost("api.example.com:8443")).toBe("api.example.com:8443");
    expect(normalizeHost("bücher.example")).toBe("xn--bcher-kva.example");
    for (const bad of ["", "https://a.com", "a.com/x", "user@a.com", "a b.com"]) expect(normalizeHost(bad)).toBeNull();
  });
});
