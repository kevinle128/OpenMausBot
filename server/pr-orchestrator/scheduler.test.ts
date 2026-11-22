import { afterEach, describe, expect, it } from "vitest";
import { stubPorts } from "./adapters/stub.ts";
import { createCommandBus } from "./command-bus.ts";
import { orchestratorConfigSchema } from "./config.ts";
import { stubHandlers } from "./handlers.ts";
import { createScheduler } from "./scheduler.ts";
import { DEFAULT_PR_KEY, ev } from "./testing/builders.ts";
import { manualTimer } from "./testing/manual-timer.ts";
import { makeHarness, type Harness } from "./testing/pm-harness.ts";
import type { CommandRecord, TimerRecord } from "./types.ts";

const DAY = 24 * 60 * 60 * 1000;
let h: Harness;
afterEach(() => h.close());

function setup(doc: Record<string, unknown> = {}) {
  h = makeHarness();
  const timer = manualTimer();
  const order: string[] = [];
  const config = orchestratorConfigSchema.parse({ enabled: true, ...doc });
  const bus = createCommandBus({
    store: h.store, pm: h.pm, ports: stubPorts(), config: () => config, now: h.clock.now, log: () => {},
    handlers: { ...stubHandlers(), RunWorkflow: async () => { order.push("RunWorkflow"); return { outcome: "succeeded" }; } },
  });
  const scheduler = createScheduler({ store: h.store, pm: h.pm, bus, now: h.clock.now, config: () => config, startTimer: timer.startTimer, log: line => h.logs.push(line) });
  scheduler.start();
  return { timer, order, scheduler, bus };
}

const armedTimer = (dueAt: number): TimerRecord => ({
  id: `timer-${dueAt}`, subjectKey: DEFAULT_PR_KEY, kind: "merge.window", idemKey: `idem-${dueAt}`, dueAt, createdAt: h.clock.now(),
  state: "armed", payload: { routineId: "wait-for-merge-window" },
});

function pendingCommand(nextAt: number): CommandRecord {
  return {
    id: `command-${nextAt}`, subjectKey: DEFAULT_PR_KEY, type: "Notify", routineId: "test", idemKey: `idem-${nextAt}`, status: "pending", outcome: null,
    approvalId: null, attempts: 0, nextAt, createdAt: h.clock.now(), updatedAt: h.clock.now(), payload: { type: "Notify", kind: "merged" }, result: null, lastError: null,
  };
}

describe("scheduler", () => {
  it("drains pending events before it fires timers and runs commands", async () => {
    const { timer, order, scheduler } = setup();
    h.setConfig({ enabled: true, workflows: { ciFix: { workflow: "ci-fix" } } });
    h.send(ev.opened());
    h.store.setMeta("last_prune_at", String(h.clock.now()));
    h.pm.accept([{ event: ev.ciFinished({ status: "failed" }), raw: "{}" }], h.clock.now());
    expect(h.commands("RunWorkflow")).toEqual([]);

    await timer.options().run();
    expect(h.store.receivedByStatus("pending", 10)).toEqual([]);
    expect(order).toEqual(["RunWorkflow"]);
    expect(h.commands("RunWorkflow")[0]).toMatchObject({ status: "done", outcome: "succeeded" });
    scheduler.stop();
    expect(timer.stopped()).toBe(true);
  });

  it("fires a due timer exactly once", async () => {
    const { timer } = setup();
    h.send(ev.opened());
    h.store.setMeta("last_prune_at", String(h.clock.now()));
    h.store.insertTimer(armedTimer(h.clock.now() + 1000));

    await timer.options().run();
    expect(h.entries("timer.fired")).toEqual([]);
    h.clock.advance(1000);
    await timer.options().run();
    await timer.options().run();
    expect(h.entries("timer.fired")).toHaveLength(1);
    expect(h.store.timersFor(DEFAULT_PR_KEY)[0]?.state).toBe("fired");
  });

  it("reports the earliest due time across timers, commands and pending events", () => {
    const { timer } = setup();
    const now = h.clock.now();
    h.store.setMeta("last_prune_at", String(now));
    h.store.insertTimer(armedTimer(now + 5000));
    expect(timer.options().next()).toBe(now + 5000);
    h.store.insertCommand(pendingCommand(now + 2000));
    expect(timer.options().next()).toBe(now + 2000);
    h.pm.accept([{ event: ev.opened(), raw: "{}" }], now);
    expect(timer.options().next()).toBe(now);
  });

  it("prunes once a day", async () => {
    const { timer } = setup();
    const start = h.clock.now();
    expect(timer.options().next()).toBe(start);
    await timer.options().run();
    expect(h.store.meta("last_prune_at")).toBe(String(start));
    expect(timer.options().next()).toBe(start + DAY);

    h.clock.advance(DAY - 1);
    await timer.options().run();
    expect(h.store.meta("last_prune_at")).toBe(String(start));
    h.clock.advance(1);
    await timer.options().run();
    expect(h.store.meta("last_prune_at")).toBe(String(start + DAY));
  });
});
