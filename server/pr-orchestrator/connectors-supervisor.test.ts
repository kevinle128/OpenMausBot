import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOrchestratorConfig } from "./config.ts";
import { createConnectorSupervisor, type ConnectorSupervisor } from "./connectors-supervisor.ts";
import { createConnectorRegistry } from "./connectors/registry.ts";
import type { ConnectorDefinition } from "./ports.ts";
import { chatEvent, createTestFeed, withTestTypes } from "./testing/fake-connectors.ts";
import { makeHarness, type Harness } from "./testing/pm-harness.ts";
import type { OrchestratorConfig } from "./types.ts";

let h: Harness;
let supervisor: ConnectorSupervisor;
afterEach(async () => {
  await supervisor.stop();
  h.close();
});

function configWith(definition: ConnectorDefinition, enabled: boolean, top = true): OrchestratorConfig {
  const parsed = parseOrchestratorConfig(
    JSON.stringify({ enabled: top, connectors: { "test-feed": { use: "test-feed", enabled, settings: {} } } }), [definition],
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.config;
}

function start(definition: ConnectorDefinition, config: () => OrchestratorConfig, sleep?: (ms: number, signal: AbortSignal) => Promise<void>) {
  const { validator, contract } = withTestTypes();
  h = makeHarness({ enabled: true }, [definition], contract);
  supervisor = createConnectorSupervisor({
    store: h.store, sink: h.pm, registry: createConnectorRegistry([definition], contract), config, key: () => null, validator,
    now: h.clock.now, log: line => h.logs.push(line), sleep,
  });
  return supervisor;
}

describe("connector supervisor", () => {
  it("starts an enabled subscription connector and stores what it emits with its cursor", () => {
    const feed = createTestFeed([chatEvent("test-feed", "a"), chatEvent("test-feed", "b")]);
    start(feed, () => configWith(feed, true)).sync();
    expect(supervisor.running()).toEqual(["test-feed"]);
    expect(h.store.receivedByStatus("pending", 10).map(row => row.eventId)).toEqual(["test-feed:a", "test-feed:b"]);
    expect(h.store.cursor("test-feed")?.cursor).toBe("b");
    expect(h.store.connectorStatus("test-feed", h.clock.now()).events24h).toBe(2);
  });

  it("rejects an emitted event that breaks the contract and logs the reason", () => {
    const bad = { ...chatEvent("test-feed", "bad"), data: { text: 1 } };
    const feed = createTestFeed([bad as never]);
    start(feed, () => configWith(feed, true)).sync();
    expect(h.store.receivedByStatus("pending", 10)).toEqual([]);
    expect(h.store.connectorStatus("test-feed", h.clock.now()).lastError).toContain("type chat.message.posted");
  });

  it("restarts a subscription that fails, with backoff", async () => {
    let calls = 0;
    const feed: ConnectorDefinition = {
      ...createTestFeed([]),
      async subscribe(ctx) {
        calls += 1;
        if (calls <= 2) throw new Error("connection lost");
        await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    };
    const delays: number[] = [];
    start(feed, () => configWith(feed, true), async ms => { delays.push(ms); }).sync();
    await vi.waitFor(() => expect(calls).toBe(3));
    expect(delays).toEqual([5000, 10_000]);
    expect(h.store.connectorStatus("test-feed", h.clock.now()).lastError).toBe("connection lost");
  });

  it("stops a subscription when its instance is disabled in the config", async () => {
    let signal: AbortSignal | null = null;
    const feed: ConnectorDefinition = {
      ...createTestFeed([]),
      async subscribe(ctx) {
        signal = ctx.signal;
        await new Promise<void>(resolve => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    };
    let enabled = true;
    start(feed, () => configWith(feed, enabled)).sync();
    expect(supervisor.running()).toEqual(["test-feed"]);
    expect((signal as AbortSignal | null)?.aborted).toBe(false);

    enabled = false;
    supervisor.sync();
    expect(supervisor.running()).toEqual([]);
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });
});
