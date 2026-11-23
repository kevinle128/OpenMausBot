import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { BY_OMB_LINE, approvalNoticeText, createApprovalNotifier } from "./approval-notice.ts";
import { SECRETS_APPROVAL_NOTICE_PREFIX } from "./connection.ts";

function fixture() {
  const connection = Object.assign(new EventEmitter(), {
    sendMessage: vi.fn(async () => {}),
  });
  let clock = 1_000_000;
  const notifier = createApprovalNotifier({ connection: connection as never, log: () => {}, now: () => clock });
  const update = (id: string, status: string) => connection.emit("agentUpdate", { id, status, updatedAt: new Date(clock).toISOString() });
  return { connection, notifier, update, tick: (ms: number) => { clock += ms; } };
}

describe("approval notice text", () => {
  it("is exactly the fixed words and the ref, even for an exec approval", () => {
    expect(approvalNoticeText({ ref: "API_KEY" })).toBe("already approved omb secrets: API_KEY");
    expect(approvalNoticeText({ ref: "API_KEY", program: "/usr/bin/deploy" })).toBe("already approved omb secrets: API_KEY");
  });

  it("ends with the by-OMB line only when OpenMausBot approved by itself, and still starts with the recognised prefix", () => {
    const text = approvalNoticeText({ ref: "API_KEY", program: "/usr/bin/deploy", by: "omb" });
    expect(text).toBe(`already approved omb secrets: API_KEY\n\n${BY_OMB_LINE}`);
    expect(BY_OMB_LINE).toBe("𝗯𝘆 𝗢𝗠𝗕");
    expect(text.startsWith(SECRETS_APPROVAL_NOTICE_PREFIX)).toBe(true);
  });
});

describe("approval notice for a secret in the OpenMausBot Vault", () => {
  it("says omb secrets, with the by-OMB line when OpenMausBot approved by itself", () => {
    expect(approvalNoticeText({ ref: "API_KEY", vault: "omb" })).toBe("already approved omb secrets: API_KEY");
    const text = approvalNoticeText({ ref: "API_KEY", vault: "omb", by: "omb", agentId: "a1", program: "/usr/bin/deploy" });
    expect(text).toBe(`already approved omb secrets: API_KEY\n\n${BY_OMB_LINE}`);
    expect(text.startsWith(SECRETS_APPROVAL_NOTICE_PREFIX)).toBe(true);
  });

  it("tells exactly the agent that was named, once it is listed, and never guesses another", async () => {
    const f = fixture();
    f.update("a1", "idle");
    f.update("a2", "idle");
    expect((await f.notifier.approved({ ref: "API_KEY", vault: "omb", agentId: "missing" })).result).toBe("none");
    expect((await f.notifier.approved({ ref: "API_KEY", vault: "omb" })).result).toBe("none");
    expect((await f.notifier.approved({ ref: "API_KEY", vault: "omb", agentId: "a1" })).result).toBe("sent");
    expect(f.connection.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.connection.sendMessage).toHaveBeenCalledWith("a1", "already approved omb secrets: API_KEY");
  });

  it("does not send the same notice twice, and still sends a different ref", async () => {
    const f = fixture();
    f.update("a1", "idle");
    expect((await f.notifier.approved({ ref: "API_KEY", vault: "omb", agentId: "a1" })).result).toBe("sent");
    expect((await f.notifier.approved({ ref: "API_KEY", agentId: "a1" })).result).toBe("none");
    expect((await f.notifier.approved({ ref: "OTHER", agentId: "a1" })).result).toBe("sent");
    expect(f.connection.sendMessage).toHaveBeenNthCalledWith(1, "a1", "already approved omb secrets: API_KEY");
    expect(f.connection.sendMessage).toHaveBeenNthCalledWith(2, "a1", "already approved omb secrets: OTHER");
  });

  it("forgets the listed agents when the daemon connection drops", async () => {
    const f = fixture();
    f.update("a1", "idle");
    f.connection.emit("disconnected", "closed");
    expect((await f.notifier.approved({ ref: "API_KEY", vault: "omb", agentId: "a1" })).result).toBe("none");
    expect(f.connection.sendMessage).not.toHaveBeenCalled();
  });

  it("holds the notice for a busy named agent until it is idle", async () => {
    const f = fixture();
    f.update("a1", "running");
    expect((await f.notifier.approved({ ref: "API_KEY", vault: "omb", agentId: "a1" })).result).toBe("queued");
    expect(f.connection.sendMessage).not.toHaveBeenCalled();
    f.update("a1", "idle");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.connection.sendMessage).toHaveBeenCalledWith("a1", "already approved omb secrets: API_KEY");
  });

  it("names the listed agent, with its title and directory", async () => {
    const f = fixture();
    f.connection.emit("agentUpdate", { id: "a1", status: "idle", title: "Fix the build", cwd: "/work/app", updatedAt: new Date().toISOString() });
    expect((await f.notifier.approved({ ref: "API_KEY", agentId: "a1" })).agent).toEqual({ agentId: "a1", title: "Fix the build", cwd: "/work/app" });
  });

  it("waits for a running agent to be idle, never interrupts, and sends once", async () => {
    const f = fixture();
    f.update("a1", "running");
    expect((await f.notifier.approved({ ref: "API_KEY", agentId: "a1" })).result).toBe("queued");
    expect(f.connection.sendMessage).not.toHaveBeenCalled();
    expect((await f.notifier.approved({ ref: "API_KEY", agentId: "a1" })).result).toBe("none");
    f.update("a1", "idle");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.connection.sendMessage).toHaveBeenCalledTimes(1);
    f.update("a1", "idle");
    await Promise.resolve();
    expect(f.connection.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("drops a waiting message after ten minutes", async () => {
    const f = fixture();
    f.update("a1", "running");
    await f.notifier.approved({ ref: "API_KEY", agentId: "a1" });
    f.tick(11 * 60_000);
    f.update("a1", "idle");
    await Promise.resolve();
    expect(f.connection.sendMessage).not.toHaveBeenCalled();
  });
});
