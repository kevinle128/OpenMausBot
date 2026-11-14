import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePackageDocument } from "../../shared/package-format.ts";
import { DISPATCHER_LABEL, dispatcherWakeMessage, startDispatcherWake, type DispatcherWakeInput } from "./dispatcher-wake.ts";

const agent = (id: string, labels: Record<string, string>, status = "idle") => ({ id, title: `Task ${id}`, status, labels }) as never;

function setup(options: { botFor?: (threadId: string) => { id: string } | null; failWake?: boolean } = {}) {
  const connection = new EventEmitter();
  const wakes: DispatcherWakeInput[] = [];
  const logs: string[] = [];
  const stop = startDispatcherWake({
    connection: connection as never,
    store: { botByThread: (threadId: string) => (options.botFor ? options.botFor(threadId) : { id: "bot-d" }) } as never,
    wake: (input) => {
      if (options.failWake) throw new Error("busy");
      wakes.push(input);
    },
    log: (line) => logs.push(line),
  });
  return { connection, wakes, logs, stop };
}

const attention = (agentId: string, reason: string, timestamp = "t1", body = "all done") =>
  ({ agentId, reason, timestamp, shouldNotify: true, notification: { title: "x", body, data: {} } }) as never;

describe("startDispatcherWake", () => {
  it("wakes the labelled thread when its agent finishes", () => {
    const { connection, wakes } = setup();
    connection.emit("agentUpdate", agent("a1", { [DISPATCHER_LABEL]: "thread-9" }));
    connection.emit("attentionRequired", attention("a1", "finished"));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ botId: "bot-d", threadId: "thread-9", deliveryId: "a1:finished:t1" });
    expect(wakes[0]!.message).toContain("Agent a1");
    expect(wakes[0]!.message).toContain("finished");
    expect(wakes[0]!.message).toContain("all done");
  });

  it("wakes on an error", () => {
    const { connection, wakes } = setup();
    connection.emit("agentUpdate", agent("a1", { [DISPATCHER_LABEL]: "thread-9" }, "error"));
    connection.emit("attentionRequired", attention("a1", "error", "t2", "boom"));
    expect(wakes[0]!.message).toContain("failed");
    expect(wakes[0]!.message).toContain("Status: error");
  });

  it("ignores permission requests and agents without the label", () => {
    const { connection, wakes } = setup();
    connection.emit("agentUpdate", agent("a1", { [DISPATCHER_LABEL]: "thread-9" }));
    connection.emit("agentUpdate", agent("a2", { other: "x" }));
    connection.emit("attentionRequired", attention("a1", "permission"));
    connection.emit("attentionRequired", attention("a2", "finished"));
    connection.emit("attentionRequired", attention("never-seen", "finished"));
    expect(wakes).toHaveLength(0);
  });

  it("does not wake twice for the same event but does for a later one", () => {
    const { connection, wakes } = setup();
    connection.emit("agentUpdate", agent("a1", { [DISPATCHER_LABEL]: "thread-9" }));
    connection.emit("attentionRequired", attention("a1", "finished", "t1"));
    connection.emit("attentionRequired", attention("a1", "finished", "t1"));
    connection.emit("attentionRequired", attention("a1", "finished", "t2"));
    expect(wakes.map((wake) => wake.deliveryId)).toEqual(["a1:finished:t1", "a1:finished:t2"]);
  });

  it("forgets a removed agent and a label taken off", () => {
    const { connection, wakes } = setup();
    connection.emit("agentUpdate", agent("a1", { [DISPATCHER_LABEL]: "thread-9" }));
    connection.emit("agentRemoved", "a1");
    connection.emit("attentionRequired", attention("a1", "finished"));
    connection.emit("agentUpdate", agent("a3", { [DISPATCHER_LABEL]: "thread-9" }));
    connection.emit("agentUpdate", agent("a3", {}));
    connection.emit("attentionRequired", attention("a3", "finished"));
    expect(wakes).toHaveLength(0);
  });

  it("logs and skips when no bot owns the thread, and retries after a failed wake", () => {
    const orphan = setup({ botFor: () => null });
    orphan.connection.emit("agentUpdate", agent("a1", { [DISPATCHER_LABEL]: "gone" }));
    orphan.connection.emit("attentionRequired", attention("a1", "finished"));
    expect(orphan.wakes).toHaveLength(0);
    expect(orphan.logs.join("\n")).toContain("no bot owns thread gone");

    const failing = setup({ failWake: true });
    failing.connection.emit("agentUpdate", agent("a1", { [DISPATCHER_LABEL]: "t" }));
    expect(() => failing.connection.emit("attentionRequired", attention("a1", "finished"))).not.toThrow();
    expect(failing.logs.join("\n")).toContain("could not wake");
  });

  it("stops listening", () => {
    const { connection, wakes, stop } = setup();
    connection.emit("agentUpdate", agent("a1", { [DISPATCHER_LABEL]: "thread-9" }));
    stop();
    connection.emit("attentionRequired", attention("a1", "finished"));
    expect(wakes).toHaveLength(0);
  });
});

describe("dispatcherWakeMessage", () => {
  it("truncates the summary, quotes it and scrubs secrets", () => {
    const message = dispatcherWakeMessage({ agentId: "a1", title: null, status: "idle", reason: "finished",
      summary: `token=sk-abcdefghijklmnopqrstuvwxyz0123456789 ${"x".repeat(2_000)}` });
    expect(message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(message.length).toBeLessThan(900);
  });
});

describe("Dispatcher preset file", () => {
  it("is a valid preset package whose bot and skill name the label", () => {
    const document = parsePackageDocument(JSON.parse(readFileSync(new URL("../../docs/presets/paseo-dispatcher.json", import.meta.url), "utf8")), { trust: "file" });
    const preset = document.package.presets![0]!;
    expect(preset.skills).toEqual(["paseo-dispatch"]);
    expect(preset.bot.soul).toContain(DISPATCHER_LABEL);
    expect(document.package.skills!.entries[0]!.instructions).toContain(DISPATCHER_LABEL);
  });
});
