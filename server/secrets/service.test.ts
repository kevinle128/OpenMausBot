import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExternalApproval } from "../external-approvals.ts";
import { BY_OMB_LINE, createApprovalNotifier, type ApprovedSecret } from "../paseo/approval-notice.ts";
import { formatAutoApproval, type AutoApproval } from "../paseo/auto-approval.ts";
import { PASEO_BOT_ID } from "../paseo/gatekeeper.ts";
import { createLiveAgents } from "../paseo/live-agents.ts";
import { VaultStore } from "../vault-store.ts";
import { AUDIT_DIR } from "./audit.ts";
import { createSecretsService, type Asker, type Caller } from "./service.ts";
import { COOLDOWN_MS, RATE_LIMIT } from "./pending.ts";
import { DAY_MS, SecretsError } from "./types.ts";

const SECRET = "sk-live-SUPERSECRETVALUE-0123456789";
const FP = `sha256:${"a".repeat(64)}`;
const HASH = `sha256:${"c".repeat(64)}`;
const agent: Caller = { id: "token-1", source: "adapter" };
const asker = (extra: Partial<Asker> = {}): Asker => ({ fingerprint: FP, project: "default", purpose: "deploy", ...extra });
const program = { path: "/usr/bin/curl", hash: HASH };

let dir: string;
let clock: number;

function fixture() {
  const vault = new VaultStore({ dataDir: dir, now: () => clock });
  const cards: ExternalApproval[] = [];
  const open = new Set<string>();
  const closed: string[] = [];
  const approvals = {
    open: (card: ExternalApproval) => (open.has(card.key) ? false : (open.add(card.key), cards.push(card), true)),
    close: (key: string) => { open.delete(key); closed.push(key); },
  };
  const history: AutoApproval[] = [];
  const logs: string[] = [];
  const told: ApprovedSecret[] = [];
  const agents = new Map([["a1", { id: "a1", title: "Deploy agent", cwd: "/work/site", status: "idle" }]]);
  const service = createSecretsService({
    vault, dataDir: dir, approvals, paseoBot: () => ({ id: PASEO_BOT_ID, name: "Paseo", threadId: "thread-paseo" }),
    history: (entry) => history.push(entry), botExists: (id) => id === "bot-1", log: (message) => logs.push(message), now: () => clock,
  });
  service.attach({
    agents: { get: (id) => agents.get(id) },
    notifier: { approved: async (approved) => (told.push(approved), { result: "sent" as const, agent: { agentId: approved.agentId ?? "", title: "Deploy agent", cwd: "/work/site" } }) },
  });
  const save = (name: string, bots: "all" | string[], value = SECRET) => vault.saveSecret({ name, value, source: "settings", bots });
  return { vault, service, cards, closed, history, logs, told, save, answer: (index: number, decision: "allow" | "deny") => cards[index]!.onAnswer(decision) };
}

const refusal = (run: () => unknown): SecretsError => {
  try {
    run();
  } catch (error) {
    if (error instanceof SecretsError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
};

function everythingWritten(f: ReturnType<typeof fixture>): string {
  const files = (root: string): string[] => readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? files(path) : name === "logins.json.enc" || name === "logins-key" ? [] : [readFileSync(path, "utf8")];
  });
  return JSON.stringify([f.cards, f.history, f.logs, f.told, files(dir)]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-secrets-service-"));
  clock = Date.parse("2026-11-19T10:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a secret kept to the Paseo bot", () => {
  it("is approved for 24 hours at once, written to the Inbox and told to the agent as OpenMausBot's own decision, and the retry gets the value", async () => {
    const f = fixture();
    f.save("API_KEY", [PASEO_BOT_ID]);
    const refused = refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker({ agentId: "a1", agentLabel: "claude", cwd: "/elsewhere" }) }, agent));
    expect(refused).toMatchObject({ exit: 8, code: "approval_pending" });
    expect(refused.message).toMatch(/approved it for 24 hours.*again/);
    await f.service.idle();
    expect(f.cards).toHaveLength(0);
    expect(f.told).toEqual([{ ref: "API_KEY", vault: "omb", by: "omb", agentId: "a1" }]);
    expect(f.history).toHaveLength(1);
    expect(f.history[0]).toMatchObject({ agent: "Deploy agent", workspace: "/work/site", rule: "omb-vault-secret" });
    expect(f.history[0]!.what).toContain("API_KEY");
    expect(f.history[0]!.what).toContain("24h");
    expect(f.history[0]!.what).toContain("đã báo agent");
    expect(formatAutoApproval(f.history[0]!, 1).split("\n")[0]).toBe("✓ OpenMausBot tự duyệt");
    expect(f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).toEqual({ ref: "API_KEY", value: SECRET });
    clock += DAY_MS + 1;
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(8);
  });

  it("is also approved when it is kept to every bot, and the same record is read as was decided", () => {
    const f = fixture();
    f.save("API_KEY", [], "sk-other-record-not-for-agents-0000");
    f.save("API_KEY", "all");
    f.save("API_KEY", [PASEO_BOT_ID], SECRET);
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(8);
    expect(f.service.resolve({ ref: "API_KEY", asker: asker() }, agent).value).toBe(SECRET);
  });

  it("covers an exec scope of its own program and variable only", async () => {
    const f = fixture();
    f.save("API_KEY", "all");
    const scopes = [{ var: "TOKEN", ref: "API_KEY", program }];
    expect(refusal(() => f.service.runCheck({ requests: scopes, asker: asker({ agentId: "a1" }) }, agent)).exit).toBe(8);
    await f.service.idle();
    expect(f.history[0]).toMatchObject({ rule: "omb-exec-owned-ref" });
    expect(f.history[0]!.what).toContain("/usr/bin/curl");
    expect(f.service.runCheck({ requests: scopes, asker: asker() }, agent)).toEqual([{ var: "TOKEN", ref: "API_KEY", value: SECRET }]);
    const other = [{ var: "TOKEN", ref: "API_KEY", program: { ...program, hash: `sha256:${"d".repeat(64)}` } }];
    expect(refusal(() => f.service.runCheck({ requests: other, asker: asker() }, agent)).exit).toBe(8);
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker({ purpose: "other" }) }, agent)).exit).toBe(8);
  });
});

describe("a secret not kept to the Paseo bot, or missing from the Vault", () => {
  it("opens one card with the agent, workspace, ref, purpose and program, and an allow writes a 24 hour grant, a history line and a plain notice", async () => {
    const f = fixture();
    f.save("API_KEY", [], SECRET);
    const call = () => f.service.runCheck({ requests: [{ var: "TOKEN", ref: "API_KEY", program }], asker: asker({ agentId: "a1", purpose: "ship the site" }) }, agent);
    expect(refusal(call).message).toMatch(/pending.*card/);
    expect(refusal(call).exit).toBe(8);
    expect(f.cards).toHaveLength(1);
    const card = f.cards[0]!;
    expect(card).toMatchObject({ threadId: "thread-paseo", tool: "omb secrets request", allowLabel: "Allow 24h", title: "A Paseo agent asks to run a program with a secret" });
    expect(card.subtitle).toBe("API_KEY · agent Deploy agent · ship the site\nWorkspace: /work/site\nOnly for /usr/bin/curl, in the variable TOKEN");
    expect(f.told).toEqual([]);
    f.answer(0, "allow");
    await f.service.idle();
    expect(f.told).toEqual([{ ref: "API_KEY", vault: "omb", program: "/usr/bin/curl", agentId: "a1" }]);
    expect(f.told[0]).not.toHaveProperty("by");
    expect(formatAutoApproval(f.history[0]!, 1)).toMatch(/^✓ Bạn đã duyệt\nAgent: Deploy agent\nWorkspace: \/work\/site\nViệc: cấp quyền chạy \/usr\/bin\/curl với bí mật API_KEY trong biến TOKEN, mục đích: ship the site, 24h · đã báo agent$/);
    expect(call()).toEqual([{ var: "TOKEN", ref: "API_KEY", value: SECRET }]);
    expect(f.service.admin.pending()).toEqual([]);
  });

  it("records a denial without a grant, tells nobody, and asks again on the next request", async () => {
    const f = fixture();
    f.save("API_KEY", [], SECRET);
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker({ agentId: "a1" }) }, agent)).exit).toBe(8);
    f.answer(0, "deny");
    await f.service.idle();
    expect(f.told).toEqual([]);
    expect(f.service.admin.grants({})).toEqual([]);
    expect(formatAutoApproval(f.history[0]!, 1).split("\n")[0]).toBe("✗ Bạn đã từ chối");
    expect(f.history[0]!.what).not.toMatch(/24h/);
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(8);
    expect(f.cards).toHaveLength(2);
  });

  it("opens a card for a ref that is not in the Vault, says so, and answers 3 once a grant covers a ref that is still missing", async () => {
    const f = fixture();
    expect(f.service.request({ ref: "NOT_THERE", asker: asker({ agentId: "a1" }) }, agent)).toMatchObject({ status: "pending" });
    expect(f.service.request({ ref: "NOT_THERE", asker: asker() }, agent)).toMatchObject({ status: "pending" });
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]!.subtitle).toContain("not in the Vault yet");
    f.answer(0, "allow");
    await f.service.idle();
    expect(refusal(() => f.service.resolve({ ref: "NOT_THERE", asker: asker() }, agent))).toMatchObject({ exit: 3, code: "no_such_secret" });
    f.save("NOT_THERE", [], SECRET);
    expect(f.service.resolve({ ref: "NOT_THERE", asker: asker() }, agent).value).toBe(SECRET);
  });

  it("opens the card again after a restart, and an admin answer closes it", () => {
    const f = fixture();
    f.save("API_KEY", [], SECRET);
    f.service.request({ ref: "API_KEY", asker: asker() }, agent);
    const [row] = f.service.admin.pending();
    expect(row).toMatchObject({ ref: "API_KEY", count: 1 });
    const again = fixture();
    expect(again.service.admin.pending()).toHaveLength(1);
    again.service.request({ ref: "API_KEY", asker: asker() }, agent);
    expect(again.cards).toHaveLength(1);
    expect(again.service.admin.pending()[0]).toMatchObject({ count: 2 });
    again.service.admin.approve({ ref: "API_KEY", state: "ttl", ttl: "2h" });
    expect(again.closed).toContain(`omb-secret:${row!.id}`);
    expect(again.service.admin.grants({})[0]).toMatchObject({ createdBy: "admin", expiresAt: clock + 2 * 3_600_000 });
  });
});

describe("grant states on the wire", () => {
  it("lets a block refuse with 6 and never file a request, even for an exec scope", () => {
    const f = fixture();
    f.save("API_KEY", [PASEO_BOT_ID]);
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, project: "default", purpose: "deploy", state: "block" });
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent))).toMatchObject({ exit: 6, code: "blocked" });
    expect(refusal(() => f.service.runCheck({ requests: [{ var: "TOKEN", ref: "API_KEY", program }], asker: asker() }, agent)).exit).toBe(6);
    expect(f.service.admin.pending()).toEqual([]);
    expect(f.cards).toEqual([]);
  });

  it("spends a single-release allow on one release only", () => {
    const f = fixture();
    f.save("API_KEY", []);
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "allow", once: true });
    expect(f.service.resolve({ ref: "API_KEY", asker: asker() }, agent).value).toBe(SECRET);
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(8);
  });

  it("ends a ttl allow on time and keeps a persistent one", () => {
    const f = fixture();
    f.save("API_KEY", []);
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "allow", ttl: "12h" });
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "forever", state: "allow", persist: true });
    clock += 13 * 3_600_000;
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(8);
    expect(f.service.resolve({ ref: "API_KEY", asker: asker({ purpose: "forever" }) }, agent).value).toBe(SECRET);
  });

  it("checks the destination of a restricted allow, and refuses with 6 when none is named", () => {
    const f = fixture();
    f.save("API_KEY", []);
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "allow", persist: true, allowHosts: ["API.example.com:443"] });
    expect(f.service.resolve({ ref: "API_KEY", asker: asker({ destHost: "api.example.com" }) }, agent).value).toBe(SECRET);
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker({ destHost: "evil.example.com" }) }, agent))).toMatchObject({ exit: 6, code: "host_not_allowed" });
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(6);
    expect(f.service.admin.pending()).toEqual([]);
  });

  it("answers a run only when every scope is covered, and spends no single-release allow when one is not", () => {
    const f = fixture();
    f.save("A", [], "value-of-a-0000000000000");
    f.save("B", [], "value-of-b-0000000000000");
    const exec = (env: string) => ({ path: program.path, hash: program.hash, env });
    f.service.admin.grant({ ref: "A", fingerprint: FP, purpose: "deploy", state: "allow", once: true, exec: exec("TOKEN_A") });
    const scopes = [{ var: "TOKEN_A", ref: "A", program }, { var: "TOKEN_B", ref: "B", program }];
    expect(refusal(() => f.service.runCheck({ requests: scopes, asker: asker() }, agent)).exit).toBe(8);
    expect(f.service.admin.grants({ ref: "A" })).toHaveLength(1);
    f.service.admin.grant({ ref: "B", fingerprint: FP, purpose: "deploy", state: "allow", persist: true, exec: exec("TOKEN_B") });
    expect(f.service.runCheck({ requests: scopes, asker: asker() }, agent).map((one) => one.ref)).toEqual(["A", "B"]);
    expect(f.service.admin.grants({ ref: "A" })).toEqual([]);
  });

  it("refuses a malformed scope with 2 before anything is decided", () => {
    const f = fixture();
    f.save("API_KEY", [PASEO_BOT_ID]);
    const bad = (extra: Partial<Asker> & { ref?: string }) => refusal(() => f.service.resolve({ ref: extra.ref ?? "API_KEY", asker: asker(extra) }, agent)).exit;
    expect(bad({ ref: "-flag" })).toBe(2);
    expect(bad({ ref: "has space" })).toBe(2);
    expect(bad({ fingerprint: "sha256:short" })).toBe(2);
    expect(bad({ project: "" })).toBe(2);
    const run = (scopes: Array<{ var: string; ref: string; program: { path: string; hash: string } }>) => refusal(() => f.service.runCheck({ requests: scopes, asker: asker() }, agent)).exit;
    expect(run([{ var: "LD_PRELOAD", ref: "API_KEY", program }])).toBe(2);
    expect(run([{ var: "TOKEN", ref: "API_KEY", program: { path: "relative/curl", hash: HASH } }])).toBe(2);
    expect(run([{ var: "TOKEN", ref: "API_KEY", program: { path: program.path, hash: "nope" } }])).toBe(2);
    expect(run([{ var: "TOKEN", ref: "API_KEY", program }, { var: "TOKEN", ref: "API_KEY", program }])).toBe(2);
    expect(f.service.admin.pending()).toEqual([]);
  });
});

describe("requests are coalesced and rate limited", () => {
  it("files repeats as one request with a count and answers 9 after 12 a minute, for five minutes", () => {
    const f = fixture();
    f.save("API_KEY", []);
    for (let i = 0; i < RATE_LIMIT; i += 1) expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(8);
    expect(f.service.admin.pending()).toHaveLength(1);
    expect(f.service.admin.pending()[0]!.count).toBe(RATE_LIMIT);
    expect(f.cards).toHaveLength(1);
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent))).toMatchObject({ exit: 9, code: "rate_limited" });
    expect(f.service.admin.pending()[0]!.count).toBe(RATE_LIMIT);
    clock += COOLDOWN_MS - 1;
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(9);
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker({ fingerprint: `sha256:${"b".repeat(64)}` }) }, agent)).exit).toBe(8);
    clock += 2;
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(8);
  });

  it("does not count calls a grant covers", () => {
    const f = fixture();
    f.save("API_KEY", []);
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "allow", persist: true });
    for (let i = 0; i < 30; i += 1) expect(f.service.resolve({ ref: "API_KEY", asker: asker() }, agent).value).toBe(SECRET);
  });
});

describe("the audit ledger comes before the value", () => {
  it("writes the row first and fails the release with 5, leaving a single-release allow unspent, when it cannot", () => {
    const f = fixture();
    f.save("API_KEY", []);
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "allow", once: true });
    rmSync(join(dir, AUDIT_DIR), { recursive: true, force: true });
    writeFileSync(join(dir, AUDIT_DIR), "not a folder");
    let leaked = "";
    const failed = refusal(() => { leaked = f.service.resolve({ ref: "API_KEY", asker: asker() }, agent).value; });
    expect(failed).toMatchObject({ exit: 5, code: "store_unavailable" });
    expect(leaked).toBe("");
    expect(f.service.admin.grants({ ref: "API_KEY" })).toHaveLength(1);
    expect(refusal(() => f.service.runCheck({ requests: [{ var: "TOKEN", ref: "API_KEY", program }], asker: asker() }, agent)).exit).toBeGreaterThanOrEqual(5);
  });

  it("records a release, a refusal and a person's answer, each without the value", () => {
    const f = fixture();
    f.save("API_KEY", [PASEO_BOT_ID]);
    refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker({ agentLabel: "claude", session: "s-1", context: "tool:Bash:command", destHost: "API.example.com" }) }, agent));
    f.service.resolve({ ref: "API_KEY", asker: asker({ context: "tool:Bash:command" }) }, agent);
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "blocked", state: "block" });
    refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker({ purpose: "blocked" }) }, agent));
    const entries = f.service.auditFor(FP, {}).entries;
    expect(entries.some((entry) => entry.decision === "allow" && entry.context === "tool:Bash:command" && entry.caller === "token-1" && entry.source === "adapter")).toBe(true);
    expect(entries.some((entry) => entry.decision === "deny" && entry.errorCode === "blocked")).toBe(true);
    expect(entries.some((entry) => entry.context.startsWith("auto:paseo-scoped") && entry.destHost === "api.example.com" && entry.sessionId === "s-1")).toBe(true);
    expect(f.service.auditFor(FP, { decision: "block" }).entries.every((entry) => entry.decision === "deny")).toBe(true);
    expect(f.service.auditFor(`sha256:${"9".repeat(64)}`, {}).entries).toEqual([]);
  });
});

describe("no value is written anywhere but the Vault", () => {
  it("is absent from cards, history, notices, logs, grants, requests and the ledger across every path", async () => {
    const f = fixture();
    f.save("AUTO_KEY", [PASEO_BOT_ID], SECRET);
    f.save("CARD_KEY", [], SECRET);
    refusal(() => f.service.resolve({ ref: "AUTO_KEY", asker: asker({ agentId: "a1", purpose: "auto" }) }, agent));
    f.service.resolve({ ref: "AUTO_KEY", asker: asker({ purpose: "auto" }) }, agent);
    refusal(() => f.service.resolve({ ref: "CARD_KEY", asker: asker({ agentId: "a1" }) }, agent));
    f.answer(0, "allow");
    await f.service.idle();
    f.service.resolve({ ref: "CARD_KEY", asker: asker() }, agent);
    f.service.admin.grant({ ref: "CARD_KEY", fingerprint: FP, purpose: "deploy", state: "allow", persist: true, exec: { ...program, env: "T" } });
    expect(f.service.runCheck({ requests: [{ var: "T", ref: "CARD_KEY", program }], asker: asker() }, agent)).toHaveLength(1);
    f.service.admin.reveal("CARD_KEY");
    f.service.list();
    f.service.describe("CARD_KEY");
    f.service.admin.rotate({ ref: "CARD_KEY", value: `${SECRET}-rotated` });
    expect(everythingWritten(f)).not.toContain("SUPERSECRETVALUE");
  });
});

describe("the Vault side", () => {
  it("lists refs with a hint and a profile, never a value, and only names a short value as having none", () => {
    const f = fixture();
    f.service.admin.set({ ref: "API_KEY", value: SECRET, bots: "paseo", profile: { description: "Billing API", projects: ["site"], tags: ["billing"], provider: "stripe" } });
    f.service.admin.set({ ref: "SHORT", value: "tiny" });
    f.save("Stripe secret key", "all", "legacy-name-0000000000000");
    const rows = f.service.list();
    expect(rows.map((row) => row.ref)).toEqual(["API_KEY", "SHORT"]);
    expect(rows[0]).toMatchObject({ creator: "omb", hint: "sk-…6789", needsRotation: false, profile: { description: "Billing API", projects: ["site"], tags: ["billing"], provider: "stripe" } });
    expect(rows[1]).toMatchObject({ hint: null, hintReason: "short value", profile: {} });
    expect(JSON.stringify(rows)).not.toContain("SUPERSECRET");
    expect(f.service.describe("API_KEY").ref).toBe("API_KEY");
    expect(refusal(() => f.service.describe("MISSING")).exit).toBe(3);
    clock += 91 * DAY_MS;
    expect(f.service.list()[0]!.needsRotation).toBe(true);
  });

  it("refuses a value that already exists with 4 unless it is forced, and a name that differs only by case or punctuation", () => {
    const f = fixture();
    f.service.admin.set({ ref: "API_KEY", value: SECRET });
    expect(refusal(() => f.service.admin.set({ ref: "API_KEY", value: "another-value-0000000" })).exit).toBe(4);
    expect(refusal(() => f.service.admin.set({ ref: "api-key", value: "another-value-0000000" })).exit).toBe(4);
    expect(f.service.admin.reveal("API_KEY").value).toBe(SECRET);
    expect(f.service.admin.set({ ref: "API_KEY", value: "another-value-0000000", force: true })).toEqual({ ref: "API_KEY", created: false });
    expect(f.service.admin.reveal("API_KEY").value).toBe("another-value-0000000");
  });

  it("keeps a new secret to no bot unless asked, so a request for it opens a card", () => {
    const f = fixture();
    f.service.admin.set({ ref: "API_KEY", value: SECRET });
    expect(f.vault.listSecrets({ person: null, team: true })[0]!.bots).toEqual([]);
    refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent));
    expect(f.cards).toHaveLength(1);
    expect(refusal(() => f.service.admin.set({ ref: "OTHER", value: SECRET, bots: ["nobody"] })).exit).toBe(2);
    f.service.admin.set({ ref: "OTHER", value: SECRET, bots: ["bot-1"] });
  });

  it("refuses a name that is not a ref, a profile that holds the value, and an unknown profile field", () => {
    const f = fixture();
    for (const ref of ["has space", "-x", "a/b", ""]) expect(refusal(() => f.service.admin.set({ ref, value: SECRET })).exit).toBe(2);
    expect(refusal(() => f.service.admin.set({ ref: "A", value: SECRET, profile: { description: `use ${SECRET} here` } })).exit).toBe(2);
    expect(refusal(() => f.service.admin.set({ ref: "A", value: SECRET, profile: { instructions: "run it" } })).exit).toBe(2);
    expect(refusal(() => f.service.admin.set({ ref: "A", value: "" })).exit).toBe(2);
    expect(f.service.list()).toEqual([]);
  });

  it("rotates a value and keeps its profile and grants, deletes a secret with its grants and requests, and says 3 for a missing one", () => {
    const f = fixture();
    f.service.admin.set({ ref: "API_KEY", value: SECRET, profile: { description: "Billing API" } });
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "allow", persist: true });
    f.service.admin.rotate({ ref: "API_KEY", value: "rotated-value-000000000" });
    expect(f.service.describe("API_KEY").profile).toEqual({ description: "Billing API" });
    expect(f.service.resolve({ ref: "API_KEY", asker: asker() }, agent).value).toBe("rotated-value-000000000");
    f.service.request({ ref: "API_KEY", asker: asker({ purpose: "other" }) }, agent);
    expect(f.service.admin.remove("API_KEY")).toMatchObject({ deleted: true, grantsRemoved: 1 });
    expect(f.service.admin.pending()).toEqual([]);
    expect(refusal(() => f.service.admin.rotate({ ref: "API_KEY", value: SECRET })).exit).toBe(3);
    expect(refusal(() => f.service.admin.remove("API_KEY")).exit).toBe(3);
    f.service.admin.set({ ref: "API_KEY", value: SECRET });
    expect(refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent)).exit).toBe(8);
  });
});

describe("answers from the person", () => {
  it("names a request by id when several match, refuses an unknown state and an unknown request, and writes a once grant", () => {
    const f = fixture();
    f.save("API_KEY", []);
    f.service.request({ ref: "API_KEY", asker: asker({ purpose: "one" }) }, agent);
    f.service.request({ ref: "API_KEY", asker: asker({ purpose: "two" }) }, agent);
    expect(refusal(() => f.service.admin.approve({ ref: "API_KEY", state: "ttl" })).exit).toBe(2);
    expect(refusal(() => f.service.admin.approve({ ref: "NOPE", state: "ttl" })).exit).toBe(2);
    expect(refusal(() => f.service.admin.approve({ ref: "API_KEY", purpose: "one", state: "maybe" as never })).exit).toBe(2);
    expect(refusal(() => f.service.admin.approve({ ref: "API_KEY", purpose: "one", state: "ttl", ttl: "soon" })).exit).toBe(2);
    f.service.admin.approve({ ref: "API_KEY", purpose: "one", state: "once" });
    expect(f.service.admin.grants({})[0]).toMatchObject({ once: true, purpose: "one", createdBy: "admin" });
    expect(f.service.admin.pending().map((request) => request.purpose)).toEqual(["two"]);
  });

  it("keeps the hosts of a restricted scope when the person approves it again", () => {
    const f = fixture();
    f.save("API_KEY", []);
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "allow", ttl: "1h", allowHosts: ["api.example.com"] });
    clock += 2 * 3_600_000;
    f.service.admin.grant({ ref: "API_KEY", fingerprint: FP, purpose: "deploy", state: "allow", ttl: "1h", allowHosts: ["api.example.com"] });
    expect(f.service.admin.grants({})).toHaveLength(1);
    f.service.request({ ref: "API_KEY", asker: asker() }, agent);
    expect(f.service.admin.pending()).toHaveLength(0);
    expect(f.service.admin.revoke({ fingerprint: FP, ref: "API_KEY", purpose: "deploy" })).toEqual({ revoked: 1 });
  });
});

describe("with the real notifier", () => {
  it("sends the agent exactly the omb notice with the by-OMB line, to the named agent only", async () => {
    const f = fixture();
    const connection = Object.assign(new EventEmitter(), { sendMessage: vi.fn(async () => {}), recentShellCommands: vi.fn(async () => []) });
    const agents = createLiveAgents(connection as never);
    const notifier = createApprovalNotifier({ connection: connection as never, origins: { find: () => null }, agents, log: () => {}, now: () => clock });
    f.service.attach({ agents, notifier });
    connection.emit("agentUpdate", { id: "a1", status: "idle", title: "Deploy agent", cwd: "/work/site", updatedAt: new Date(clock).toISOString() });
    connection.emit("agentUpdate", { id: "a2", status: "idle", title: "Other", cwd: "/x", updatedAt: new Date(clock).toISOString() });
    f.save("API_KEY", [PASEO_BOT_ID]);
    refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker({ agentId: "a1" }) }, agent));
    await f.service.idle();
    expect(connection.sendMessage).toHaveBeenCalledTimes(1);
    expect(connection.sendMessage).toHaveBeenCalledWith("a1", `already approved omb secrets: API_KEY\n\n${BY_OMB_LINE}`);
    expect(f.history[0]).toMatchObject({ agent: "Deploy agent", workspace: "/work/site" });
    notifier.stop();
    agents.stop();
  });

  it("never lets a named agent that the daemon does not list steer the notice or the card", async () => {
    const f = fixture();
    f.save("API_KEY", []);
    refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker({ agentId: "ghost", agentLabel: "claude", cwd: "/claimed" }) }, agent));
    expect(f.cards[0]!.subtitle).toBe("API_KEY · agent claude · deploy\nWorkspace: /claimed");
    f.answer(0, "allow");
    await f.service.idle();
    expect(f.told[0]).not.toHaveProperty("agentId");
  });
});

describe("without the Paseo bridge", () => {
  it("still decides, opens cards and writes history, and tells nobody", async () => {
    const f = fixture();
    f.save("API_KEY", [PASEO_BOT_ID]);
    const detach = f.service.attach({ agents: { get: () => undefined }, notifier: { approved: async () => ({ result: "none" as const }) } });
    detach();
    refusal(() => f.service.resolve({ ref: "API_KEY", asker: asker() }, agent));
    await f.service.idle();
    expect(f.history[0]!.what).not.toContain("đã báo agent");
    expect(f.service.resolve({ ref: "API_KEY", asker: asker() }, agent).value).toBe(SECRET);
  });
});
