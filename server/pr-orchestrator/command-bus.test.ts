import { afterEach, describe, expect, it } from "vitest";
import { stubPorts } from "./adapters/stub.ts";
import { noneAttached, switchedPorts } from "./adapters/switched.ts";
import { portHandlers } from "./command-handlers.ts";
import { createCommandBus, type CommandBus } from "./command-bus.ts";
import { orchestratorConfigSchema } from "./config.ts";
import { stubHandlers, type CommandHandlers } from "./handlers.ts";
import { DEFAULT_PR_KEY, ev } from "./testing/builders.ts";
import { makeHarness, type Harness } from "./testing/pm-harness.ts";
import { scriptedHandlers } from "./testing/recording-ports.ts";
import type { CommandRecord, CommandResult, CommandWait, PrKey } from "./types.ts";

let h: Harness;
afterEach(() => h.close());

function bus(handlers: Partial<CommandHandlers>, doc: Record<string, unknown> = {}): CommandBus {
  const config = orchestratorConfigSchema.parse({ enabled: true, ...doc });
  return createCommandBus({
    store: h.store, pm: h.pm, handlers: { ...stubHandlers(), ...handlers }, ports: stubPorts(),
    config: () => config, now: h.clock.now, log: line => h.logs.push(line),
  });
}

let counter = 0;
function queue(subjectKey: PrKey = DEFAULT_PR_KEY, type: CommandRecord["type"] = "Notify"): CommandRecord {
  const id = `queued-${++counter}`;
  const command: CommandRecord = {
    id, subjectKey, type, routineId: "test", idemKey: `idem-${id}`, status: "pending", outcome: null, approvalId: null, attempts: 0,
    nextAt: h.clock.now(), createdAt: h.clock.now(), updatedAt: h.clock.now(),
    payload: type === "Merge"
      ? { type: "Merge", method: "squash", expectedHeadSha: "a".repeat(40), deleteBranch: true }
      : { type: "Notify", kind: "merged" },
    result: null, lastError: null,
  };
  expect(h.store.insertCommand(command)).toBe(true);
  return command;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("command bus", () => {
  it("runs at most one command per PR at a time", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const first = queue();
    const second = queue();
    const gate = deferred<CommandResult>();
    const started: string[] = [];
    const commands = bus({ Notify: async command => { started.push(command.id); return gate.promise; } });

    expect(await commands.runDue()).toBe(1);
    expect(commands.inFlight()).toBe(1);
    expect(await commands.runDue()).toBe(0);
    expect(started).toEqual([first.id]);

    gate.resolve({ outcome: "succeeded" });
    await commands.idle();
    expect(await commands.runDue()).toBe(1);
    await commands.idle();
    expect(started).toEqual([first.id, second.id]);
  });

  it("backs off a retryable failure and finishes it as failed after the attempt limit", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const command = queue();
    let calls = 0;
    const commands = bus(
      { Notify: async () => { calls += 1; return { outcome: "failed", reason: "forge is down", retryable: true }; } },
      { commands: { maxAttempts: 3, backoffSeconds: { initial: 1, max: 2 } } },
    );

    await commands.runDue();
    await commands.idle();
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "pending", attempts: 1, nextAt: h.clock.now() + 1000, lastError: "forge is down" });
    expect(await commands.runDue()).toBe(0);

    h.clock.advance(1000);
    await commands.runDue();
    await commands.idle();
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "pending", attempts: 2, nextAt: h.clock.now() + 2000 });

    h.clock.advance(2000);
    await commands.runDue();
    await commands.idle();
    expect(calls).toBe(3);
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "done", outcome: "failed", attempts: 3 });
  });

  it("records a command whose port is not installed as skipped, never as succeeded", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const command = queue(DEFAULT_PR_KEY, "Merge");
    const commands = bus({
      Merge: async (_command, ctx) => {
        await ctx.ports.forge.github.merge({} as never, { method: "squash", expectedHeadSha: "a", deleteBranch: false });
        return { outcome: "succeeded" };
      },
    });
    await commands.runDue();
    await commands.idle();
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "done", outcome: "skipped", result: { outcome: "skipped", reason: "not installed" } });
  });

  it("feeds the result back as a ledger entry", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const command = queue();
    const commands = bus(scriptedHandlers({ Notify: () => ({ outcome: "succeeded" }) }));
    await commands.runDue();
    await commands.idle();
    expect(h.entries("command.finished")).toEqual([
      expect.objectContaining({ commandId: command.id, command: "Notify", result: { outcome: "succeeded" } }),
    ]);
  });

  it("finishes the row when recording the result fails, so the subject is not held", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const command = queue();
    const config = orchestratorConfigSchema.parse({ enabled: true });
    const commands = createCommandBus({
      store: h.store, pm: { ...h.pm, finishCommand: () => { throw new Error("route failed"); } }, handlers: stubHandlers(), ports: stubPorts(),
      config: () => config, now: h.clock.now, log: line => h.logs.push(line),
    });
    await commands.runDue();
    await commands.idle();
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "done" });
    expect(h.logs.some(line => line.includes("could not be recorded: route failed"))).toBe(true);
  });

  it("finishes a command of a pruned PR as skipped", async () => {
    h = makeHarness();
    const command = queue("github:acme/gone#9");
    let called = false;
    const commands = bus({ Notify: async () => { called = true; return { outcome: "succeeded" }; } });
    await commands.runDue();
    await commands.idle();
    expect(called).toBe(false);
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "done", outcome: "skipped", result: { outcome: "skipped", reason: "pr gone" } });
  });

  it("runs a waiting command again after its fixed delay", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const command = queue();
    let calls = 0;
    const commands = bus({
      Notify: async () => {
        calls += 1;
        return calls === 1 ? { outcome: "waiting", reason: "the forge is computing", retryAfterSeconds: 45 } satisfies CommandWait : { outcome: "succeeded" };
      },
    });
    await commands.runDue();
    await commands.idle();
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "pending", attempts: 0, waits: 1, nextAt: h.clock.now() + 45_000, lastError: "the forge is computing" });
    expect(h.entries("command.finished")).toEqual([]);
    expect(await commands.runDue()).toBe(0);

    h.clock.advance(45_000);
    await commands.runDue();
    await commands.idle();
    expect(calls).toBe(2);
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "done", outcome: "succeeded" });
  });

  it("finishes a command that waited more times than the limit as skipped", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const command = queue();
    const commands = bus(
      { Notify: async () => ({ outcome: "waiting", reason: "the daemon is down", retryAfterSeconds: 10 }) },
      { commands: { maxWaits: 3 } },
    );
    for (let round = 0; round < 4; round += 1) {
      await commands.runDue();
      await commands.idle();
      h.clock.advance(10_000);
    }
    expect(h.store.getCommand(command.id)).toMatchObject({
      status: "done", outcome: "skipped", attempts: 1, waits: 3, result: { outcome: "skipped", reason: "waited too long: the daemon is down" },
    });
    expect(h.entries("command.finished")).toHaveLength(1);
  });

  it("keeps the whole retry budget and the first backoff of a command that waited before it failed", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const command = queue();
    let calls = 0;
    const commands = bus(
      {
        Notify: async () => {
          calls += 1;
          return calls <= 4 ? { outcome: "waiting", reason: "the daemon is down", retryAfterSeconds: 10 } : { outcome: "failed", reason: "flaky", retryable: true };
        },
      },
      { commands: { maxAttempts: 2, backoffSeconds: { initial: 7, max: 600 } } },
    );
    for (let round = 0; round < 5; round += 1) {
      await commands.runDue();
      await commands.idle();
      if (round < 4) h.clock.advance(10_000);
    }
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "pending", attempts: 1, waits: 4, nextAt: h.clock.now() + 7_000, lastError: "flaky" });
  });

  it("does not let a waiting command hold the other commands of its PR", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const waiting = queue();
    const other = queue(DEFAULT_PR_KEY, "Merge");
    const commands = bus({
      Notify: async () => ({ outcome: "waiting", reason: "later", retryAfterSeconds: 60 }),
      Merge: async () => ({ outcome: "succeeded" }),
    });
    await commands.runDue();
    await commands.idle();
    expect(h.store.getCommand(waiting.id)).toMatchObject({ status: "pending" });
    await commands.runDue();
    await commands.idle();
    expect(h.store.getCommand(other.id)).toMatchObject({ status: "done", outcome: "succeeded" });
  });

  it("waits while a switched-on port has no adapter attached", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const command = queue(DEFAULT_PR_KEY, "Merge");
    const config = orchestratorConfigSchema.parse({ enabled: true, adapters: { forge: { github: { enabled: true } } } });
    const ports = switchedPorts(() => config, noneAttached);
    const commands = createCommandBus({
      store: h.store, pm: h.pm, handlers: portHandlers(), ports, installed: ports.installed,
      config: () => config, now: h.clock.now, log: line => h.logs.push(line),
    });
    await commands.runDue();
    await commands.idle();
    expect(h.store.getCommand(command.id)).toMatchObject({
      status: "pending", nextAt: h.clock.now() + 60_000, lastError: "the GitHub adapter is not attached yet",
    });
  });

  it("records a command for a port that is switched off as not installed, before any other check", async () => {
    h = makeHarness();
    h.send(ev.opened());
    const command = queue(DEFAULT_PR_KEY, "Merge");
    const config = orchestratorConfigSchema.parse({ enabled: true });
    const ports = switchedPorts(() => config, noneAttached);
    const commands = createCommandBus({
      store: h.store, pm: h.pm, handlers: portHandlers(), ports, installed: ports.installed,
      config: () => config, now: h.clock.now, log: line => h.logs.push(line),
    });
    await commands.runDue();
    await commands.idle();
    expect(h.store.getCommand(command.id)).toMatchObject({ status: "done", result: { outcome: "skipped", reason: "not installed" } });
  });
});
