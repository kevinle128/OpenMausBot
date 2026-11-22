/* oxlint-disable unicorn/no-thenable -- a routine's action list is named "then" in the config document */
import { afterAll, describe, expect, it } from "vitest";
import { parseOrchestratorConfig } from "./config.ts";
import { createConnectorSupervisor } from "./connectors-supervisor.ts";
import { BUILT_IN_CONNECTORS } from "./connectors/index.ts";
import { createConnectorRegistry } from "./connectors/registry.ts";
import { describeConnectorConformance, type DeliverResult } from "./contract/conformance/index.ts";
import { createCoreParts } from "./core.ts";
import type { ConnectorDefinition } from "./ports.ts";
import { openOrchestratorStore } from "./store.ts";
import { counterIds, fakeClock } from "./testing/builders.ts";
import { FAKE_HUB_KEY, startDoor, type DoorHarness } from "./testing/door-harness.ts";
import { chatEvent, createTestFeed, testHook, withTestTypes } from "./testing/fake-connectors.ts";
import { manualTimer } from "./testing/manual-timer.ts";

const injected = withTestTypes();
const BEARER = { authorization: `Bearer ${FAKE_HUB_KEY.toString()}`, "content-type": "application/json" };
const hookInstances = { "test-hook": { definition: testHook as ConnectorDefinition, settings: {}, secretName: "TEST_HOOK_SECRET" } };

let door: DoorHarness;
const doorReady = startDoor({ validator: injected.validator }, hookInstances).then(started => { door = started; });
afterAll(async () => { await doorReady; await door.close(); });

/** The door answers `{ taken }` only; the reasons of rejected events are in its log. */
async function deliverToHook(events: unknown[]): Promise<DeliverResult> {
  await doorReady;
  const result: DeliverResult = { accepted: [], rejected: [] };
  for (const event of events) {
    const before = door.logs.length;
    const answer = await fetch(`${door.base}/events/test-hook`, { method: "POST", headers: BEARER, body: JSON.stringify(event) });
    expect(answer.status).toBe(202);
    const rejected = door.logs.slice(before).find(entry => entry.outcome === "rejected");
    const id = (event as { id?: string }).id ?? null;
    if (rejected) result.rejected.push({ id, reason: rejected.detail ?? "" });
    else if (id !== null) result.accepted.push(id);
  }
  return result;
}

const hookSamples = [chatEvent("test-hook", "hook-1"), chatEvent("test-hook", "hook-2", "again")];
describeConnectorConformance(testHook, { samples: hookSamples, deliver: deliverToHook, contract: injected });
describeConnectorConformance(createTestFeed([]), { samples: [chatEvent("test-feed", "feed-1")], contract: injected });

describe("a connector that only a test registers", () => {
  it("routes events of a connector added in the test through the intake, the store and a routine without changing core files", async () => {
    const feed = createTestFeed([chatEvent("test-feed", "feed-1", "from the feed")]);
    const definitions = [...BUILT_IN_CONNECTORS, testHook, feed] as ConnectorDefinition[];
    const parsed = parseOrchestratorConfig(JSON.stringify({
      enabled: true,
      connectors: {
        "test-hook": { use: "test-hook", enabled: true, secretName: "TEST_HOOK_SECRET", settings: {} },
        "test-feed": { use: "test-feed", enabled: true, settings: {} },
      },
      routines: {
        custom: [{
          id: "tell-me-about-messages", name: "Tell me about messages", active: true,
          when: { connectors: ["test-hook"], on: ["chat.message.posted"] },
          then: [{ do: "Notify", params: { kind: "merged" } }], once: "per-trigger",
        }],
      },
    }), definitions);
    if (!parsed.ok) throw new Error(parsed.error);
    const { config } = parsed;

    const store = openOrchestratorStore(":memory:");
    const clock = fakeClock();
    const registry = createConnectorRegistry(definitions, injected.contract);
    const parts = createCoreParts({
      store, connectors: registry, config: () => ({ config, version: "test", error: null }), now: clock.now, newId: counterIds("x"),
      startTimer: manualTimer().startTimer, log: () => {},
    });
    const logs: string[] = [];
    const supervisor = createConnectorSupervisor({
      store, sink: parts.pm, registry, config: () => config, key: () => null, validator: injected.validator, now: clock.now, log: line => logs.push(line),
    });

    await doorReady;
    const live = await startDoor({
      validator: injected.validator, sink: parts.pm, now: clock.now, log: entry => store.logConnector({ ...entry, at: clock.now() }),
    }, hookInstances);
    const answer = await fetch(`${live.base}/events/test-hook`, { method: "POST", headers: BEARER, body: JSON.stringify(chatEvent("test-hook", "hook-9")) });
    expect(answer.status).toBe(202);
    supervisor.sync();
    await supervisor.stop();
    await live.close();

    parts.pm.drain();
    expect(store.receivedByStatus("applied", 10).map(row => row.eventId).sort()).toEqual(["test-feed:feed-1", "test-hook:hook-9"]);
    expect(store.ledgerKeys().sort()).toEqual(["subject:test-feed:thread:thread-1", "subject:test-hook:thread:thread-1"]);
    expect(store.listPrs({ limit: 10 })).toEqual([]);
    const matched = store.ledgerKeys().flatMap(key => store.ledger(key)).filter(row => row.entry.type === "routine.matched");
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ subjectKey: "subject:test-hook:thread:thread-1", entry: { routineId: "tell-me-about-messages" } });
    expect(store.commandsFor("subject:test-hook:thread:thread-1").map(command => command.type)).toEqual(["Notify"]);
    expect(store.commandsFor("subject:test-feed:thread:thread-1")).toEqual([]);
    store.close();
  });
});
