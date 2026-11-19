import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AutoApproval } from "../paseo/auto-approval.ts";
import { createExternalApprovals } from "../external-approvals.ts";
import type { Notification } from "../notify.ts";
import type { Message } from "../store.ts";
import { AkError, createAkCli, type AkCli, type AkGrant, type AkPendingRequest, type AkRemoteRequest, type AkRunner } from "./cli.ts";
import { createAkGuard } from "./guard.ts";
import { startInboxWatcher } from "./inbox-watcher.ts";

const PROGRAM_HASH = "sha256:aa";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const AGENT = "sha256:0123456789abcdef0123456789abcdef";

let stops: Array<() => void> = [];
let dirs: string[] = [];
afterEach(() => {
  for (const stop of stops) stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  stops = [];
  dirs = [];
});

function setup(options: { owned?: string[]; locked?: boolean; pollMs?: number; debounceMs?: number; secretsDir?: string; origin?: { agentId: string; agent: string; cwd: string }; notify?: "sent" | "queued" | "none"; notifiedAgent?: { agentId: string; title: string; cwd: string }; remotePollMs?: number; noRemote?: boolean; remote?: boolean } = {}) {
  const told: Array<{ ref: string; program?: string; by?: "omb" }> = [];
  const history: AutoApproval[] = [];
  const lines: Message[] = [];
  const store = {
    appendMessage: (_threadId: string, message: Partial<Message>) => {
      const added = { id: `m${lines.length + 1}`, at: Date.now(), ...message } as Message;
      lines.push(added);
      return added;
    },
    patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => Object.assign(lines.find((line) => line.id === id) ?? {}, patch),
    messagesFor: () => lines,
  };
  const approvals = createExternalApprovals({ store: store as never });
  const inbox: { requests: AkPendingRequest[]; listError: Error | null; grants: AkGrant[]; remote: AkRemoteRequest[]; remoteError: Error | null } = { requests: [], listError: null, grants: [], remote: [], remoteError: null };
  const remoteRequests = vi.fn(async () => {
    if (inbox.remoteError) throw inbox.remoteError;
    return inbox.remote;
  });
  const approveRemote = vi.fn<AkCli["approveRemote"]>(async () => {});
  const denyRemote = vi.fn<AkCli["denyRemote"]>(async () => {});
  const approve = vi.fn<AkCli["approve"]>(async () => {});
  const deny = vi.fn<AkCli["deny"]>(async () => {});
  const grantExec = vi.fn<AkCli["grantExec"]>(async () => null);
  const revokeExec = vi.fn<AkCli["revokeExec"]>(async () => {});
  const grants = vi.fn(async () => inbox.grants);
  const pendingRequests = vi.fn(async () => {
    if (inbox.listError) throw inbox.listError;
    return inbox.requests;
  });
  const logs: string[] = [];
  const notified: Array<Notification | null> = [];
  const guard = createAkGuard((line) => logs.push(line));
  const owned = new Set(options.owned ?? []);
  const watcher = startInboxWatcher({
    cli: { pendingRequests, approve, deny, grantExec, revokeExec, grants, ...(options.noRemote ? {} : { remoteRequests, approveRemote, denyRemote }) },
    remotePollMs: options.remotePollMs ?? 0,
    ...(options.remote
      ? { remote: true }
      : { hashFile: async () => PROGRAM_HASH, realPath: async (path: string) => (path === "/opt/homebrew/bin/deploy" ? "/usr/bin/deploy" : path) }),
    guard,
    approvals,
    owns: (ref) => owned.has(ref),
    bot: () => ({ id: "paseo-gatekeeper", name: "Paseo", threadId: "paseo-thread" }),
    notify: (notification) => notified.push(notification),
    screenLocked: async () => options.locked === true,
    log: (line) => logs.push(line),
    history: (entry) => history.push(entry),
    ...(options.notify ? { notifyAgent: async (approved: { ref: string; program?: string; by?: "omb" }) => { told.push(approved); return { result: options.notify!, ...(options.notifiedAgent ? { agent: options.notifiedAgent } : {}) }; } } : {}),
    origins: { find: (ref) => (options.origin && ref === "API_KEY" ? options.origin : null) },
    secretsDir: options.secretsDir ?? "/nonexistent-ak-dir",
    pollMs: options.pollMs ?? 3_600_000,
    debounceMs: options.debounceMs ?? 10,
  });
  stops.push(watcher.stop);
  const card = () => lines.find((line) => line.card)?.card;
  return { remoteRequests, approveRemote, denyRemote, watcher, approvals, inbox, approve, deny, grantExec, revokeExec, grants, pendingRequests, logs, notified, guard, lines, card, history, told };
}

const ordinary = (ref: string): AkPendingRequest => ({ ref, agent: AGENT, project: "app", purpose: "deploy" });
// The shape `ak secrets approve --json` lists: the variable, program and hash are inside `exec`.
const exec = (ref: string, path = "/usr/bin/deploy", hash: string | null = PROGRAM_HASH): AkPendingRequest => ({
  ref, fingerprint: AGENT, agentLabel: "claude", project: "app", purpose: "run", count: 1, firstSeen: "2026-11-18T07:00:00Z", lastSeen: "2026-11-18T07:25:00Z", exec: { env: "TOKEN", path, ...(hash ? { hash } : {}) },
});
const grantFor = (ref: string, path = "/usr/bin/deploy", hash = PROGRAM_HASH, extra: Partial<AkGrant> = {}): AkGrant => ({
  ref, fingerprint: AGENT, project: "app", purpose: "run", state: "allow", createdAt: "2026-11-18T07:30:00Z", exec: { env: "TOKEN", path, hash }, ...extra,
});

describe("ak inbox watcher", () => {
  it("allows an ordinary request for a secret OpenMausBot wrote, for 24 hours, once", async () => {
    const t = setup({ owned: ["API_KEY"] });
    t.inbox.requests = [ordinary("API_KEY")];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.approve).toHaveBeenCalledTimes(1);
    expect(t.approve).toHaveBeenCalledWith({ ref: "API_KEY", agent: AGENT, project: "app", purpose: "deploy", env: "", ttl: "24h" });
    expect(t.lines).toEqual([]);
  });

  it("records an allowed request with the secret's ref, purpose and 24 hours, and names the Paseo agent that asked", async () => {
    const t = setup({ owned: ["API_KEY"], origin: { agentId: "agent-1", agent: "Fix the build", cwd: "/work/app" } });
    t.inbox.requests = [ordinary("API_KEY")];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.history).toEqual([{ key: `ak:API_KEY|agent-1|deploy|`, agent: "Fix the build", workspace: "/work/app", what: "cấp quyền đọc bí mật API_KEY, mục đích: deploy, 24h", rule: "ak-vault-secret" }]);
  });

  it("does not name an agent when two agents asked for the ref", async () => {
    const { createRequestOrigins } = await import("../paseo/auto-approval.ts");
    const origins = createRequestOrigins();
    origins.note("ak secrets request API_KEY", { agentId: "a1", agent: "One", cwd: "/one" });
    origins.note("ak secrets request API_KEY", { agentId: "a2", agent: "Two", cwd: "/two" });
    expect(origins.find("API_KEY")).toBeNull();
    origins.note("ak secrets request OTHER", { agentId: "a1", agent: "One", cwd: "/one" });
    expect(origins.find("OTHER")).toMatchObject({ agentId: "a1" });
  });

  it("tells the agent after an automatic approval and marks the history line", async () => {
    const t = setup({ owned: ["API_KEY"], notify: "sent" });
    t.inbox.requests = [ordinary("API_KEY")];
    await t.watcher.checkNow();
    expect(t.told).toEqual([{ ref: "API_KEY", by: "omb" }]);
    expect(t.history[0]!.what).toContain("đã báo agent");
  });

  it("names the agent the notice found when the gatekeeper never saw it ask", async () => {
    const t = setup({ owned: ["API_KEY"], notify: "sent", notifiedAgent: { agentId: "a1", title: "Fix the build", cwd: "/work/app" } });
    t.inbox.requests = [ordinary("API_KEY")];
    await t.watcher.checkNow();
    expect(t.history[0]).toMatchObject({ agent: "Fix the build", workspace: "/work/app" });
  });

  it("tells the agent when the person taps Allow on a card, with the program for an exec request", async () => {
    const t = setup({ notify: "queued" });
    t.inbox.requests = [exec("DEPLOY_TOKEN")];
    await t.watcher.checkNow();
    t.approvals.answer(t.card()!.requestId!, "allow");
    await flush();
    expect(t.told).toEqual([{ ref: "DEPLOY_TOKEN", program: "/usr/bin/deploy" }]);
    expect(t.told[0]).not.toHaveProperty("by");
  });

  it("says the agent is not known when nobody was told", async () => {
    const t = setup({ owned: ["API_KEY"], notify: "none" });
    t.inbox.requests = [ordinary("API_KEY")];
    await t.watcher.checkNow();
    expect(t.history[0]!.what).toContain("không rõ agent");
  });

  it("says the project is not known when no Paseo agent asked for the ref", async () => {
    const t = setup({ owned: ["API_KEY"] });
    t.inbox.requests = [ordinary("API_KEY")];
    await t.watcher.checkNow();
    expect(t.history).toMatchObject([{ workspace: "không rõ project" }]);
  });

  it("writes no history line for a request that went to a card until the person answers it", async () => {
    const t = setup();
    t.inbox.requests = [ordinary("STRANGER")];
    await t.watcher.checkNow();
    expect(t.history).toEqual([]);
  });

  it("writes one history line for the person's Allow and one for their Deny, each with its answer", async () => {
    const t = setup();
    t.inbox.requests = [ordinary("STRANGER")];
    await t.watcher.checkNow();
    t.approvals.answer(t.card()!.requestId!, "allow");
    await flush();
    expect(t.history).toMatchObject([{ rule: "person", answer: { decision: "allow" }, what: "cấp quyền đọc bí mật STRANGER, mục đích: deploy, 24h" }]);

    t.inbox.requests = [ordinary("OTHER")];
    await t.watcher.checkNow();
    t.approvals.answer(t.lines.findLast((line) => line.card)!.card!.requestId!, "deny");
    await flush();
    expect(t.history[1]).toMatchObject({ rule: "person", answer: { decision: "deny" }, what: "cấp quyền đọc bí mật OTHER, mục đích: deploy" });
    expect(t.history[0]!.key).not.toBe(t.history[1]!.key);
  });

  it("writes no history line when the person's answer does not reach ak", async () => {
    const t = setup();
    t.deny.mockRejectedValueOnce(new Error("ak is locked"));
    t.inbox.requests = [ordinary("STRANGER")];
    await t.watcher.checkNow();
    t.approvals.answer(t.card()!.requestId!, "deny");
    await flush();
    expect(t.history).toEqual([]);
  });

  it("puts a request for a secret not in the Vault scope on a card, and a Deny answers it once", async () => {
    const t = setup({ locked: true });
    t.inbox.requests = [ordinary("STRANGER")];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.lines.filter((line) => line.card)).toHaveLength(1);
    expect(t.card()).toMatchObject({ title: "A Paseo agent asks for a secret", options: ["Allow 24h", "Deny"] });
    expect(t.card()?.subtitle).toContain("STRANGER");
    expect(t.notified).toHaveLength(1);

    t.approvals.answer(t.card()!.requestId!, "deny");
    await flush();
    expect(t.deny).toHaveBeenCalledWith({ ref: "STRANGER", agent: AGENT, project: "app", purpose: "deploy", env: "" });
    await t.watcher.checkNow();
    expect(t.lines.filter((line) => line.card)).toHaveLength(1);
  });

  it("allows an exec request for an owned ref for its own program and variable, for 24 hours, and records it", async () => {
    const t = setup({ owned: ["DEPLOY_TOKEN"] });
    t.inbox.requests = [{ ...exec("DEPLOY_TOKEN"), purpose: "deploy with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }];
    await t.watcher.checkNow();
    expect(t.lines).toEqual([]);
    expect(t.approve).toHaveBeenCalledWith({ ref: "DEPLOY_TOKEN", agent: AGENT, project: "app", purpose: expect.any(String), env: "TOKEN", ttl: "24h" });
    expect(t.history).toHaveLength(1);
    expect(t.history[0]).toMatchObject({ rule: "ak-exec-owned-ref" });
    expect(t.history[0]!.what).toContain("/usr/bin/deploy");
    expect(t.history[0]!.what).toContain("TOKEN");
    expect(t.history[0]!.what).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("puts an exec request for a ref OpenMausBot does not own on a card, and Allow answers that exact scope for 24 hours", async () => {
    const t = setup({ owned: ["OTHER"] });
    t.inbox.requests = [exec("DEPLOY_TOKEN")];
    await t.watcher.checkNow();
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.history).toEqual([]);
    expect(t.card()).toMatchObject({ title: "A Paseo agent asks to run a program with a secret" });
    expect(t.card()?.subtitle).toContain("/usr/bin/deploy");
    expect(t.card()?.subtitle).toContain("TOKEN");

    t.approvals.answer(t.card()!.requestId!, "allow");
    await flush();
    expect(t.approve).toHaveBeenCalledWith({ ref: "DEPLOY_TOKEN", agent: AGENT, project: "app", purpose: "run", env: "TOKEN", ttl: "24h" });
  });

  const AMBIGUOUS = new AkError("invalid", 2, "secrets approve: 2 waiting requests match; narrow it with --agent, --project, --purpose or --env");

  async function answerAmbiguous(t: ReturnType<typeof setup>, requests: AkPendingRequest[]) {
    t.inbox.requests = requests;
    await t.watcher.checkNow();
    t.approve.mockRejectedValueOnce(AMBIGUOUS);
    t.approvals.answer(t.lines[0]!.card!.requestId!, "allow");
    await flush();
  }

  it("reads the variable of an exec request from exec.env, and shows the program that will be granted", async () => {
    const t = setup({ owned: ["OTHER"] });
    t.inbox.requests = [exec("DEPLOY_TOKEN", "/opt/homebrew/Cellar/x/bin/deploy")];
    await t.watcher.checkNow();
    expect(t.card()?.subtitle).toContain("/opt/homebrew/Cellar/x/bin/deploy");
    expect(t.card()?.subtitle).toContain("variable TOKEN");
    t.approvals.answer(t.card()!.requestId!, "allow");
    await flush();
    expect(t.approve).toHaveBeenCalledWith({ ref: "DEPLOY_TOKEN", agent: AGENT, project: "app", purpose: "run", env: "TOKEN", ttl: "24h" });
  });

  it("allows an exec request by its program when approve finds two waiting requests that differ only in the program", async () => {
    const t = setup({ owned: ["OTHER"] });
    t.grantExec.mockImplementationOnce(async () => {
      t.inbox.grants.push(grantFor("DEPLOY_TOKEN"));
      return null;
    });
    await answerAmbiguous(t, [exec("DEPLOY_TOKEN"), exec("DEPLOY_TOKEN", "/usr/bin/true", "sha256:bb")]);
    expect(t.grantExec).toHaveBeenCalledTimes(1);
    expect(t.grantExec).toHaveBeenCalledWith({ ref: "DEPLOY_TOKEN", agent: AGENT, project: "app", purpose: "run", env: "TOKEN", program: "/usr/bin/deploy", ttl: "24h", agentLabel: "claude" });
    expect(t.revokeExec).not.toHaveBeenCalled();
  });

  it("accepts the grant ak returns when it names the program through a link", async () => {
    const t = setup({ owned: ["OTHER"] });
    t.grantExec.mockResolvedValueOnce({ exec: { env: "TOKEN", path: "/opt/homebrew/bin/deploy", hash: PROGRAM_HASH } });
    await answerAmbiguous(t, [exec("DEPLOY_TOKEN")]);
    expect(t.revokeExec).not.toHaveBeenCalled();
    expect(t.grants).toHaveBeenCalledTimes(1);
  });

  it("revokes the grant and reports an error when ak recorded a different program than the request named", async () => {
    const t = setup({ owned: ["OTHER"] });
    t.grantExec.mockResolvedValueOnce({ exec: { env: "TOKEN", path: "/usr/bin/true", hash: "sha256:bb" } });
    await answerAmbiguous(t, [exec("DEPLOY_TOKEN")]);
    expect(t.revokeExec).toHaveBeenCalledWith({ ref: "DEPLOY_TOKEN", agent: AGENT, env: "TOKEN", program: "/usr/bin/true", project: "app", purpose: "run" });
    expect(t.lines[0]?.card).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(t.logs.join("\n")).toContain("another program or hash");
  });

  it("reads the grants back when ak returns no hash, and revokes when none matches", async () => {
    const t = setup({ owned: ["OTHER"] });
    await answerAmbiguous(t, [exec("DEPLOY_TOKEN")]);
    expect(t.grants).toHaveBeenCalled();
    expect(t.revokeExec).toHaveBeenCalledTimes(1);
  });

  it("revokes the path read back from the grants when ak returned no path, and names that path", async () => {
    const t = setup({ owned: ["OTHER"] });
    t.inbox.grants = [grantFor("DEPLOY_TOKEN", "/usr/bin/true", "sha256:bb")];
    t.revokeExec.mockImplementationOnce(async () => {
      t.inbox.grants = [];
    });
    await answerAmbiguous(t, [exec("DEPLOY_TOKEN")]);
    expect(t.revokeExec).toHaveBeenCalledWith(expect.objectContaining({ program: "/usr/bin/true" }));
    expect(t.logs.join("\n")).not.toContain("by hand");
  });

  it("says the wrong grant may still be there when revoke refuses the program or the grant is still listed", async () => {
    const refused = setup({ owned: ["OTHER"] });
    refused.grantExec.mockResolvedValueOnce({ exec: { env: "TOKEN", path: "/usr/bin/true", hash: "sha256:bb" } });
    refused.revokeExec.mockRejectedValueOnce(new AkError("invalid", 2, "program not found"));
    await answerAmbiguous(refused, [exec("DEPLOY_TOKEN")]);
    expect(refused.logs.join("\n")).toContain("revoke refused the program");
    expect(refused.logs.join("\n")).toContain("run ak secrets revoke by hand");

    const listed = setup({ owned: ["OTHER"] });
    listed.inbox.grants = [grantFor("DEPLOY_TOKEN", "/usr/bin/true", "sha256:bb")];
    listed.grantExec.mockResolvedValueOnce({ exec: { env: "TOKEN", path: "/usr/bin/true", hash: "sha256:bb" } });
    await answerAmbiguous(listed, [exec("DEPLOY_TOKEN")]);
    expect(listed.logs.join("\n")).toContain("the wrong grant is still listed");
  });

  it("logs a grants failure that lasts once, and the reason a failed read-back leads to a revoke", async () => {
    const t = setup({ owned: ["OTHER"] });
    t.grants.mockRejectedValue(new AkError("backend", 5, "grants locked"));
    t.inbox.requests = [exec("DEPLOY_TOKEN")];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.logs.filter((line) => line.includes("could not read the grants"))).toHaveLength(1);
    t.approve.mockRejectedValueOnce(AMBIGUOUS);
    t.approvals.answer(t.lines[0]!.card!.requestId!, "allow");
    await flush();
    expect(t.logs.join("\n")).toContain("the grants could not be read back");
    expect(t.revokeExec).toHaveBeenCalled();
  });

  it("does not grant by program when the request has no hash, when the file changed, or when the project is missing", async () => {
    for (const request of [exec("DEPLOY_TOKEN", "/usr/bin/deploy", null), exec("DEPLOY_TOKEN", "/usr/bin/deploy", "sha256:changed"), { ...exec("DEPLOY_TOKEN"), project: undefined }]) {
      const t = setup({ owned: ["OTHER"] });
      await answerAmbiguous(t, [request as AkPendingRequest]);
      expect(t.grantExec).not.toHaveBeenCalled();
    }
  });

  it("opens no card and grants nothing again for an exec request an earlier grant still covers", async () => {
    const t = setup({ owned: ["DEPLOY_TOKEN"] });
    t.inbox.grants = [grantFor("DEPLOY_TOKEN", "/usr/bin/deploy", PROGRAM_HASH, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() })];
    t.inbox.requests = [exec("DEPLOY_TOKEN")];
    await t.watcher.checkNow();
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.grantExec).not.toHaveBeenCalled();
    expect(t.lines).toEqual([]);
  });

  it("still asks when the earlier grant was recorded before the agent last asked, or is for another project, purpose or agent", async () => {
    for (const grant of [grantFor("DEPLOY_TOKEN", "/usr/bin/deploy", PROGRAM_HASH, { createdAt: "2026-11-18T07:20:00Z" }), grantFor("DEPLOY_TOKEN", "/usr/bin/deploy", PROGRAM_HASH, { project: "other" }), grantFor("DEPLOY_TOKEN", "/usr/bin/deploy", PROGRAM_HASH, { purpose: "other" }), grantFor("DEPLOY_TOKEN", "/usr/bin/deploy", PROGRAM_HASH, { fingerprint: "sha256:other" })]) {
      const t = setup({ owned: ["OTHER"] });
      t.inbox.grants = [grant];
      t.inbox.requests = [exec("DEPLOY_TOKEN")];
      await t.watcher.checkNow();
      expect(t.card()).toBeDefined();
    }
  });

  it("still asks when the earlier grant is expired, has another hash or is for another variable", async () => {
    for (const grant of [grantFor("DEPLOY_TOKEN", "/usr/bin/deploy", PROGRAM_HASH, { expiresAt: new Date(Date.now() - 1000).toISOString() }), grantFor("DEPLOY_TOKEN", "/usr/bin/deploy", "sha256:bb"), { ...grantFor("DEPLOY_TOKEN"), exec: { env: "OTHER", path: "/usr/bin/deploy", hash: PROGRAM_HASH } }]) {
      const t = setup({ owned: ["OTHER"] });
      t.inbox.grants = [grant];
      t.inbox.requests = [exec("DEPLOY_TOKEN")];
      await t.watcher.checkNow();
      expect(t.card()).toBeDefined();
    }
  });

  it("opens a new card when answering a card fails and the request is still in the inbox", async () => {
    const t = setup();
    t.inbox.requests = [ordinary("STRANGER")];
    await t.watcher.checkNow();
    t.approve.mockRejectedValueOnce(new AkError("backend", 5, "inbox locked"));
    t.approvals.answer(t.card()!.requestId!, "allow");
    await flush();
    expect(t.lines.filter((line) => line.card)[0]?.card).toMatchObject({ answered: "unavailable", dismissed: true });
    await t.watcher.checkNow();
    const cards = t.lines.filter((line) => line.card);
    expect(cards).toHaveLength(2);
    t.approvals.answer(cards[1]!.card!.requestId!, "allow");
    await flush();
    expect(t.approve).toHaveBeenCalledTimes(2);
    await t.watcher.checkNow();
    expect(t.lines.filter((line) => line.card)).toHaveLength(2);
  });

  it("opens a new card when a deny fails too", async () => {
    const t = setup();
    t.inbox.requests = [ordinary("STRANGER")];
    await t.watcher.checkNow();
    t.deny.mockRejectedValueOnce(new Error("could not run"));
    t.approvals.answer(t.card()!.requestId!, "deny");
    await flush();
    await t.watcher.checkNow();
    expect(t.lines.filter((line) => line.card)).toHaveLength(2);
  });

  it("ignores a request whose ref is not a valid ref: no card, no approve, no deny, one log line", async () => {
    const t = setup({ owned: ["--reveal", "-y", "a/b", " pad", ""] });
    t.inbox.requests = [ordinary("--reveal"), ordinary("-y"), ordinary("a/b"), ordinary(" pad"), ordinary("x".repeat(129)), ordinary("A\u202eB"), ordinary("")];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.deny).not.toHaveBeenCalled();
    expect(t.lines).toEqual([]);
    expect(t.logs.filter((line) => line.includes("not a valid ref"))).toHaveLength(6);
    t.inbox.requests = [ordinary("--reveal"), ordinary("GOOD")];
    await t.watcher.checkNow();
    expect(t.card()?.subtitle).toContain("GOOD");
    expect(t.logs.filter((line) => line.includes("not a valid ref"))).toHaveLength(6);
  });

  it("closes a card when its request leaves the inbox", async () => {
    const t = setup();
    t.inbox.requests = [ordinary("STRANGER")];
    await t.watcher.checkNow();
    expect(t.approvals.keys()).toHaveLength(1);
    t.inbox.requests = [];
    await t.watcher.checkNow();
    expect(t.approvals.keys()).toHaveLength(0);
    expect(t.card()).toMatchObject({ answered: "unavailable", dismissed: true });
  });

  it("treats two agents asking for one ref as two requests", async () => {
    const t = setup({ owned: ["K"] });
    t.inbox.requests = [ordinary("K"), { ...ordinary("K"), agent: "sha256:ffff" }];
    await t.watcher.checkNow();
    expect(t.approve).toHaveBeenCalledTimes(2);
  });

  it("asks a person after allowing keeps failing, without spinning", async () => {
    const t = setup({ owned: ["K"] });
    t.approve.mockRejectedValue(new AkError("backend", 5, "inbox locked"));
    t.inbox.requests = [ordinary("K")];
    for (let i = 0; i < 6; i += 1) await t.watcher.checkNow();
    expect(t.approve).toHaveBeenCalledTimes(3);
    expect(t.approvals.keys()).toHaveLength(1);
  });

  it("turns auto-approval off, closes cards and logs once when ak refuses to run under an agent", async () => {
    const t = setup({ owned: ["K"] });
    t.inbox.requests = [ordinary("OTHER")];
    await t.watcher.checkNow();
    expect(t.approvals.keys()).toHaveLength(1);
    t.inbox.listError = new AkError("agent-above-process", 6, "refused");
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.guard.blocked).toBe(true);
    expect(t.approvals.keys()).toHaveLength(0);
    expect(t.logs.filter((line) => line.includes("refused to run"))).toHaveLength(1);
    const calls = t.pendingRequests.mock.calls.length;
    await t.watcher.checkNow();
    expect(t.pendingRequests.mock.calls.length).toBe(calls);
  });

  it("logs a failed read once and keeps going", async () => {
    const t = setup();
    t.inbox.listError = new AkError("unavailable", null, "The ak program was not found");
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.logs.filter((line) => line.includes("not found"))).toHaveLength(1);
    expect(t.guard.blocked).toBe(false);
  });

  it("reads the fields ak lists, narrows an approval by the agent fingerprint and logs no shape warning", async () => {
    const fingerprint = `sha256:${"ab".repeat(32)}`;
    const t = setup({ owned: ["API_KEY"] });
    t.inbox.requests = [
      { ref: "API_KEY", project: "app", purpose: "deploy", fingerprint, agentLabel: "claude", count: 2, firstSeen: "2026-11-15T10:00:00Z", lastSeen: "2026-11-15T10:05:00Z", exec: null },
    ];
    await t.watcher.checkNow();
    expect(t.approve).toHaveBeenCalledWith({ ref: "API_KEY", agent: fingerprint, project: "app", purpose: "deploy", env: "", ttl: "24h" });
    expect(t.logs.filter((line) => line.includes("unexpected request shape"))).toEqual([]);
  });

  it("names the agent on a card by its label and answers the card for that fingerprint", async () => {
    const fingerprint = `sha256:${"cd".repeat(32)}`;
    const t = setup();
    t.inbox.requests = [{ ref: "STRANGER", project: "app", purpose: "deploy", fingerprint, agentLabel: "claude", exec: null }];
    await t.watcher.checkNow();
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.card()?.subtitle).toContain("agent claude");
  });

  it("logs the keys of the first unknown request shape and never a value", async () => {
    const t = setup();
    t.inbox.requests = [{ ref: "R", weird: "secret-looking-text" } as AkPendingRequest, { nothing: "x" } as unknown as AkPendingRequest];
    await t.watcher.checkNow();
    const shape = t.logs.filter((line) => line.includes("unexpected request shape"));
    expect(shape).toEqual(["ak inbox: unexpected request shape, keys: ref, weird"]);
    expect(t.logs.join("\n")).not.toContain("secret-looking-text");
  });

  it("reads the inbox again after the inbox file changes, and on the fallback timer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-inbox-"));
    dirs.push(dir);
    const t = setup({ secretsDir: dir, debounceMs: 20, pollMs: 100 });
    await t.watcher.checkNow();
    const before = t.pendingRequests.mock.calls.length;
    writeFileSync(join(dir, "pending.json"), "{}");
    await vi.waitFor(() => expect(t.pendingRequests.mock.calls.length).toBeGreaterThan(before), { timeout: 3_000 });
    const afterWatch = t.pendingRequests.mock.calls.length;
    await vi.waitFor(() => expect(t.pendingRequests.mock.calls.length).toBeGreaterThan(afterWatch + 1), { timeout: 3_000 });
  });

  it("does not watch the inbox folder when ak runs on another device", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-inbox-"));
    dirs.push(dir);
    const t = setup({ secretsDir: dir, debounceMs: 10, pollMs: 60_000, remote: true });
    await t.watcher.checkNow();
    const before = t.pendingRequests.mock.calls.length;
    writeFileSync(join(dir, "pending.json"), "{}");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(t.pendingRequests.mock.calls.length).toBe(before);
  });

  it("fails closed on an ambiguous exec request when ak runs on another device, even if a local file matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-prog-"));
    dirs.push(dir);
    const program = join(dir, "deploy");
    writeFileSync(program, "#!/bin/sh\n");
    const hash = `sha256:${createHash("sha256").update("#!/bin/sh\n").digest("hex")}`;
    const t = setup({ owned: ["OTHER"], remote: true });
    await answerAmbiguous(t, [exec("DEPLOY_TOKEN", program, hash)]);
    expect(t.grantExec).not.toHaveBeenCalled();
    expect(t.lines[0]?.card).toMatchObject({ answered: "unavailable", dismissed: true });
  });
});

describe("requests from other devices", () => {
  const remote = (id: string, ref: string, extra: Partial<AkRemoteRequest> = {}): AkRemoteRequest => ({ id, ref, project: "app", purpose: "deploy", agentLabel: "claude", device: "MacBook", ...extra });
  const syncOff = () => new AkError("sync-off", 10, "secrets approvals list: sync is not enabled on this device");

  it("allows a remote request for an owned ref by its id for 24 hours, once, and records it", async () => {
    const t = setup({ owned: ["API_KEY"], notify: "sent" });
    t.inbox.remote = [remote("3f2a", "API_KEY")];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.approveRemote).toHaveBeenCalledTimes(1);
    expect(t.approveRemote).toHaveBeenCalledWith({ id: "3f2a", ttl: "24h" });
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.lines).toEqual([]);
    expect(t.told).toEqual([{ ref: "API_KEY", by: "omb" }]);
    expect(t.history).toMatchObject([{ rule: "ak-vault-secret", what: "cấp quyền đọc bí mật API_KEY, mục đích: deploy, 24h · đã báo agent" }]);
  });

  it("puts a remote request for an unknown ref on a card and answers Allow and Deny through approvals", async () => {
    const t = setup();
    t.inbox.remote = [remote("aa11", "STRANGER"), remote("bb22", "OTHER")];
    await t.watcher.checkNow();
    const cards = t.lines.filter((line) => line.card).map((line) => line.card!);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ options: ["Allow 24h", "Deny"] });
    expect(cards[0]?.subtitle).toContain("From MacBook");
    t.approvals.answer(cards[0]!.requestId!, "allow");
    t.approvals.answer(cards[1]!.requestId!, "deny");
    await flush();
    expect(t.approveRemote).toHaveBeenCalledWith({ id: "aa11", ttl: "24h" });
    expect(t.denyRemote).toHaveBeenCalledWith({ id: "bb22" });
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.deny).not.toHaveBeenCalled();
    expect(t.history.map((entry) => (entry.answer as { decision: string }).decision).sort()).toEqual(["allow", "deny"]);
    expect(t.history.find((entry) => (entry.answer as { decision: string }).decision === "deny")!.what).not.toContain("24h");
  });

  it("asks again when the answer does not reach ak, and closes the card once the request leaves the list", async () => {
    const t = setup();
    t.denyRemote.mockRejectedValueOnce(new Error("ak is locked"));
    t.inbox.remote = [remote("aa11", "STRANGER")];
    await t.watcher.checkNow();
    t.approvals.answer(t.card()!.requestId!, "deny");
    await flush();
    expect(t.history).toEqual([]);
    await t.watcher.checkNow();
    expect(t.lines.filter((line) => line.card)).toHaveLength(2);
    t.inbox.remote = [];
    await t.watcher.checkNow();
    expect(t.approvals.keys()).toEqual([]);
  });

  it("keeps a remote and a local request for the same ref apart", async () => {
    const t = setup({ owned: ["API_KEY"] });
    t.inbox.requests = [ordinary("API_KEY")];
    t.inbox.remote = [remote("3f2a", "API_KEY", { fingerprint: AGENT, agent: AGENT })];
    await t.watcher.checkNow();
    expect(t.approve).toHaveBeenCalledTimes(1);
    expect(t.approveRemote).toHaveBeenCalledTimes(1);
    const strange = setup();
    strange.inbox.requests = [ordinary("STRANGER")];
    strange.inbox.remote = [remote("3f2a", "STRANGER", { project: "app", purpose: "deploy", agent: AGENT })];
    await strange.watcher.checkNow();
    expect(strange.lines.filter((line) => line.card)).toHaveLength(2);
    expect(new Set(strange.approvals.keys()).size).toBe(2);
    strange.approvals.answer(strange.lines.findLast((line) => line.card)!.card!.requestId!, "deny");
    await flush();
    expect(strange.denyRemote).toHaveBeenCalledWith({ id: "3f2a" });
    expect(strange.deny).not.toHaveBeenCalled();
  });

  it("stays quiet when sync is off: one log line, the local inbox keeps working, cards of remote requests close", async () => {
    const t = setup({ owned: ["API_KEY"] });
    t.inbox.remote = [remote("aa11", "STRANGER")];
    await t.watcher.checkNow();
    expect(t.lines.filter((line) => line.card)).toHaveLength(1);
    t.inbox.remoteError = syncOff();
    t.inbox.requests = [ordinary("API_KEY")];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.logs.filter((line) => line.includes("sync is off"))).toHaveLength(1);
    expect(t.approve).toHaveBeenCalledTimes(1);
    expect(t.approvals.keys()).toEqual([]);
    expect(t.guard.blocked).toBe(false);
  });

  it("stops the pass after one call when ak cannot run, without listing the local inbox", async () => {
    const t = setup();
    t.inbox.remoteError = new AkError("unavailable", null, "The laptop (h) is unreachable over SSH: timed out");
    await t.watcher.checkNow();
    expect(t.remoteRequests).toHaveBeenCalledTimes(1);
    expect(t.pendingRequests).not.toHaveBeenCalled();
    expect(t.logs).toEqual(["ak inbox: could not read the inbox (unavailable: The laptop (h) is unreachable over SSH: timed out)"]);
  });

  it("logs another remote failure once and keeps the last list", async () => {
    const t = setup();
    t.inbox.remote = [remote("aa11", "STRANGER")];
    await t.watcher.checkNow();
    t.inbox.remoteError = new AkError("failed", 1, "offline");
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.logs.filter((line) => line.includes("offline"))).toHaveLength(1);
    expect(t.approvals.keys()).toHaveLength(1);
  });

  it("skips a remote request without id or ref and logs its keys once, never a value", async () => {
    const t = setup();
    t.inbox.remote = [{ ref: "R", note: "value-not-logged" }, { id: "x" }] as AkRemoteRequest[];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.logs.filter((line) => line.includes("remote request shape"))).toEqual(["ak inbox: unexpected remote request shape, keys: ref, note"]);
    expect(t.lines).toEqual([]);
  });

  it("lists remote requests at most once per interval, and backs off after a failure or with sync off", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = setup({ remotePollMs: 5_000 });
      await t.watcher.checkNow();
      await t.watcher.checkNow();
      expect(t.remoteRequests).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5_000);
      t.inbox.remoteError = new AkError("failed", 1, "offline");
      await t.watcher.checkNow();
      expect(t.remoteRequests).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(29_999);
      await t.watcher.checkNow();
      expect(t.remoteRequests).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      t.inbox.remoteError = syncOff();
      await t.watcher.checkNow();
      expect(t.remoteRequests).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(59_999);
      await t.watcher.checkNow();
      expect(t.remoteRequests).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(1);
      await t.watcher.checkNow();
      expect(t.remoteRequests).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps answering local requests when the cli cannot list remote requests", async () => {
    const t = setup({ owned: ["API_KEY"], noRemote: true });
    t.inbox.requests = [ordinary("API_KEY")];
    await t.watcher.checkNow();
    expect(t.remoteRequests).not.toHaveBeenCalled();
    expect(t.approve).toHaveBeenCalledTimes(1);
  });

  it("lists again before retrying a remote answer that failed, so a request answered elsewhere opens no card", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t = setup({ owned: ["API_KEY"], remotePollMs: 5_000 });
      t.approveRemote.mockRejectedValueOnce(new AkError("failed", 1, "already answered"));
      // The first listing, already started, finds the request; it is answered elsewhere before the next one.
      t.inbox.remote.push(remote("3f2a", "API_KEY"));
      t.inbox.remote = [];
      for (let i = 0; i < 3; i += 1) await t.watcher.checkNow();
      expect(t.remoteRequests).toHaveBeenCalledTimes(2);
      expect(t.approveRemote).toHaveBeenCalledTimes(1);
      expect(t.lines).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the pass and calls ak no more when listing remote requests is refused under an agent", async () => {
    const t = setup({ owned: ["API_KEY"] });
    t.inbox.remote = [remote("aa11", "STRANGER")];
    await t.watcher.checkNow();
    expect(t.approvals.keys()).toHaveLength(1);
    const calls = t.pendingRequests.mock.calls.length;
    t.inbox.requests = [ordinary("API_KEY")];
    t.inbox.remoteError = new AkError("agent-above-process", 6, "refused");
    await t.watcher.checkNow();
    expect(t.guard.blocked).toBe(true);
    expect(t.pendingRequests.mock.calls.length).toBe(calls);
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.approvals.keys()).toEqual([]);
    expect(t.logs.filter((line) => line.includes("refused to run"))).toHaveLength(1);
  });

  it("answers a remote request whose id starts with \"-\", and ignores one whose id is not base64url with one log line", async () => {
    const t = setup({ owned: ["API_KEY"] });
    t.inbox.remote = [remote("-x3f2a", "API_KEY"), remote("a/b", "STRANGER")];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.approveRemote).toHaveBeenCalledTimes(1);
    expect(t.approveRemote).toHaveBeenCalledWith(expect.objectContaining({ id: "-x3f2a" }));
    expect(t.lines.filter((line) => line.card)).toEqual([]);
    expect(t.logs.filter((line) => line.includes("id is not a valid id"))).toHaveLength(1);
  });

  it("names another device when the device name is empty, and reads the ref past an empty one", async () => {
    const t = setup();
    t.inbox.remote = [remote("aa11", "", { secret: "STRANGER", device: { name: " ", label: "" } })];
    await t.watcher.checkNow();
    expect(t.card()?.subtitle).toContain("STRANGER");
    expect(t.card()?.subtitle).toContain("From another device");
  });
});

describe("approve --json shapes", () => {
  const run = (stdout: string): AkRunner => async () => ({ exitCode: 0, stdout, stderr: "" });

  it("reads a bare array, a keyed list and null, and reports an unknown shape's keys only", async () => {
    const unknown: string[][] = [];
    const cli = (stdout: string) => createAkCli(run(stdout), { onUnknownShape: (keys) => unknown.push(keys) });
    expect(await cli(JSON.stringify({ data: [{ ref: "A" }] })).pendingRequests()).toEqual([{ ref: "A" }]);
    expect(await cli(JSON.stringify({ data: { pending: [{ ref: "B" }] } })).pendingRequests()).toEqual([{ ref: "B" }]);
    expect(await cli(JSON.stringify({ data: null })).pendingRequests()).toEqual([]);
    expect(unknown).toEqual([]);
    expect(await cli(JSON.stringify({ data: { surprise: "value-not-logged" } })).pendingRequests()).toEqual([]);
    expect(unknown).toEqual([["surprise"]]);
  });
});
