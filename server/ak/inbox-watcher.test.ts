import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createExternalApprovals } from "../external-approvals.ts";
import type { Notification } from "../notify.ts";
import type { Message } from "../store.ts";
import { AkError, createAkCli, type AkCli, type AkPendingRequest, type AkRunner } from "./cli.ts";
import { createAkGuard } from "./guard.ts";
import { startInboxWatcher } from "./inbox-watcher.ts";

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

function setup(options: { owned?: string[]; locked?: boolean; pollMs?: number; debounceMs?: number; secretsDir?: string } = {}) {
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
  const inbox: { requests: AkPendingRequest[]; listError: Error | null } = { requests: [], listError: null };
  const approve = vi.fn<AkCli["approve"]>(async () => {});
  const deny = vi.fn<AkCli["deny"]>(async () => {});
  const pendingRequests = vi.fn(async () => {
    if (inbox.listError) throw inbox.listError;
    return inbox.requests;
  });
  const logs: string[] = [];
  const notified: Array<Notification | null> = [];
  const guard = createAkGuard((line) => logs.push(line));
  const owned = new Set(options.owned ?? []);
  const watcher = startInboxWatcher({
    cli: { pendingRequests, approve, deny },
    guard,
    approvals,
    owns: (ref) => owned.has(ref),
    bot: () => ({ id: "paseo-gatekeeper", name: "Paseo", threadId: "paseo-thread" }),
    notify: (notification) => notified.push(notification),
    screenLocked: async () => options.locked === true,
    log: (line) => logs.push(line),
    secretsDir: options.secretsDir ?? "/nonexistent-ak-dir",
    pollMs: options.pollMs ?? 3_600_000,
    debounceMs: options.debounceMs ?? 10,
  });
  stops.push(watcher.stop);
  const card = () => lines.find((line) => line.card)?.card;
  return { watcher, approvals, inbox, approve, deny, pendingRequests, logs, notified, guard, lines, card };
}

const ordinary = (ref: string): AkPendingRequest => ({ ref, agent: AGENT, project: "app", purpose: "deploy" });
const exec = (ref: string): AkPendingRequest => ({ ref, agent: AGENT, project: "app", purpose: "run", env: "TOKEN", exec: "/usr/bin/deploy" });

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

  it("puts a request for a secret not in the Vault scope on a card, and a Deny answers it once", async () => {
    const t = setup({ locked: true });
    t.inbox.requests = [ordinary("STRANGER")];
    await t.watcher.checkNow();
    await t.watcher.checkNow();
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.lines.filter((line) => line.card)).toHaveLength(1);
    expect(t.card()).toMatchObject({ title: "A Paseo agent asks for a secret", options: ["Allow", "Deny"] });
    expect(t.card()?.subtitle).toContain("STRANGER");
    expect(t.notified).toHaveLength(1);

    t.approvals.answer(t.card()!.requestId!, "deny");
    await flush();
    expect(t.deny).toHaveBeenCalledWith({ ref: "STRANGER", agent: AGENT, project: "app", purpose: "deploy", env: "" });
    await t.watcher.checkNow();
    expect(t.lines.filter((line) => line.card)).toHaveLength(1);
  });

  it("puts an exec request on a card even for an owned ref, and Allow answers that exact scope for 24 hours", async () => {
    const t = setup({ owned: ["DEPLOY_TOKEN"] });
    t.inbox.requests = [exec("DEPLOY_TOKEN")];
    await t.watcher.checkNow();
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.card()).toMatchObject({ title: "A Paseo agent asks to run a program with a secret" });
    expect(t.card()?.subtitle).toContain("/usr/bin/deploy");
    expect(t.card()?.subtitle).toContain("TOKEN");

    t.approvals.answer(t.card()!.requestId!, "allow");
    await flush();
    expect(t.approve).toHaveBeenCalledWith({ ref: "DEPLOY_TOKEN", agent: AGENT, project: "app", purpose: "run", env: "TOKEN", ttl: "24h" });
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
