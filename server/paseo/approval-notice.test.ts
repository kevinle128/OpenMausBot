import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { BY_OMB_LINE, approvalNoticeText, commandNamesRef, createApprovalNotifier } from "./approval-notice.ts";
import { createRequestOrigins } from "./auto-approval.ts";
import { APPROVAL_NOTICE_PREFIX } from "./connection.ts";

function fixture(commands: Record<string, string[]> = {}) {
  const connection = Object.assign(new EventEmitter(), {
    sendMessage: vi.fn(async () => {}),
    recentShellCommands: vi.fn(async (agentId: string) => commands[agentId] ?? []),
  });
  let clock = 1_000_000;
  const origins = createRequestOrigins(() => clock);
  const notifier = createApprovalNotifier({ connection: connection as never, origins, log: () => {}, now: () => clock });
  const update = (id: string, status: string) => connection.emit("agentUpdate", { id, status, updatedAt: new Date(clock).toISOString() });
  return { connection, origins, notifier, update, tick: (ms: number) => { clock += ms; } };
}

describe("approval notice text", () => {
  it("is exactly the fixed words and the ref, even for an exec approval", () => {
    expect(approvalNoticeText({ ref: "API_KEY" })).toBe("already approved ak secrets: API_KEY");
    expect(approvalNoticeText({ ref: "API_KEY", program: "/usr/bin/deploy" })).toBe("already approved ak secrets: API_KEY");
  });

  it("ends with the by-OMB line only when OpenMausBot approved by itself, and still starts with the recognised prefix", () => {
    const text = approvalNoticeText({ ref: "API_KEY", program: "/usr/bin/deploy", by: "omb" });
    expect(text).toBe("already approved ak secrets: API_KEY\n\n\u{1D5EF}\u{1D606} \u{1D5E2}\u{1D5E0}\u{1D5D5}");
    expect(BY_OMB_LINE).toBe("𝗯𝘆 𝗢𝗠𝗕");
    expect(text.startsWith(APPROVAL_NOTICE_PREFIX)).toBe(true);
  });
});

describe("commandNamesRef", () => {
  it.each([
    ["ak secrets request API_KEY", true],
    ["ak secrets run --env T=API_KEY -- node x.js", true],
    ["ak secrets request API_KEY_2", false],
    ["echo API_KEY", false],
  ])("%j -> %s", (command, expected) => expect(commandNamesRef(command, "API_KEY")).toBe(expected));
});

describe("approval notice delivery", () => {
  it("tells the one agent whose recent command names the ref, when it is idle", async () => {
    const f = fixture({ a1: ["ak secrets request API_KEY"], a2: ["ls"] });
    f.update("a1", "idle");
    f.update("a2", "idle");
    expect((await f.notifier.approved({ ref: "API_KEY" })).result).toBe("sent");
    expect(f.connection.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.connection.sendMessage).toHaveBeenCalledWith("a1", expect.stringMatching(/^already approved ak secrets: API_KEY/));
  });

  it("tells nobody when no agent or two agents match", async () => {
    const none = fixture({ a1: ["ls"] });
    none.update("a1", "idle");
    expect((await none.notifier.approved({ ref: "API_KEY" })).result).toBe("none");
    const two = fixture({ a1: ["ak secrets request API_KEY"], a2: ["ak secrets run --env T=API_KEY -- x"] });
    two.update("a1", "idle");
    two.update("a2", "idle");
    expect((await two.notifier.approved({ ref: "API_KEY" })).result).toBe("none");
    expect(two.connection.sendMessage).not.toHaveBeenCalled();
  });

  it("names the agent found through its commands, with its title and directory", async () => {
    const f = fixture({ a1: ["ak secrets request API_KEY"] });
    f.connection.emit("agentUpdate", { id: "a1", status: "idle", title: "Fix the build", cwd: "/work/app", updatedAt: new Date().toISOString() });
    expect((await f.notifier.approved({ ref: "API_KEY" })).agent).toEqual({ agentId: "a1", title: "Fix the build", cwd: "/work/app" });
  });

  it("prefers the agent the gatekeeper saw ask for the ref", async () => {
    const f = fixture();
    f.origins.note("ak secrets request API_KEY", { agentId: "a9", agent: "Nine", cwd: "/w" });
    f.update("a9", "idle");
    expect((await f.notifier.approved({ ref: "API_KEY" })).result).toBe("sent");
    expect(f.connection.sendMessage).toHaveBeenCalledWith("a9", expect.any(String));
  });

  it("waits for a running agent to be idle, never interrupts, and sends once", async () => {
    const f = fixture({ a1: ["ak secrets request API_KEY"] });
    f.update("a1", "running");
    expect((await f.notifier.approved({ ref: "API_KEY" })).result).toBe("queued");
    expect(f.connection.sendMessage).not.toHaveBeenCalled();
    expect((await f.notifier.approved({ ref: "API_KEY" })).result).toBe("none");
    f.update("a1", "idle");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.connection.sendMessage).toHaveBeenCalledTimes(1);
    f.update("a1", "idle");
    await Promise.resolve();
    expect(f.connection.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a waiting message after ten minutes", async () => {
    const f = fixture({ a1: ["ak secrets request API_KEY"] });
    f.update("a1", "running");
    await f.notifier.approved({ ref: "API_KEY" });
    f.tick(11 * 60_000);
    f.update("a1", "idle");
    await Promise.resolve();
    expect(f.connection.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores an agent that was not active in the last ten minutes", async () => {
    const f = fixture({ a1: ["ak secrets request API_KEY"] });
    f.update("a1", "idle");
    f.tick(11 * 60_000);
    expect((await f.notifier.approved({ ref: "API_KEY" })).result).toBe("none");
  });
});
