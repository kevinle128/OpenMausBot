import { afterAll, describe, expect, it } from "vitest";
import { describeConnectorConformance, invalidFixtures, validFixtures, type DeliverResult } from "../contract/conformance/index.ts";
import { postBatch, startDoor, type DoorHarness } from "../testing/door-harness.ts";
import { githubEvent } from "./github-event.ts";
import { gitlabEvent } from "./gitlab-event.ts";

let harness: DoorHarness;
const ready = startDoor().then(started => { harness = started; });
afterAll(async () => { await ready; await harness.close(); });

function asForge(event: unknown, connector: string, forge: string): unknown {
  const value = event as { source: object; subject: object };
  return { ...value, source: { ...value.source, connector }, subject: { ...value.subject, forge } };
}

for (const [definition, forge] of [[githubEvent, "github"], [gitlabEvent, "gitlab"]] as const) {
  const samples = validFixtures().map(fixture => asForge(fixture.event, definition.id, forge));
  describeConnectorConformance(definition, { samples, deliver: async events => deliverWithReasons(definition.id, events) });
}

/** The hub's answer names rejected ids only; the reasons are in the door's log. */
async function deliverWithReasons(instance: string, events: unknown[]): Promise<DeliverResult> {
  await ready;
  const before = harness.logs.length;
  const answer = await postBatch(harness, instance, events);
  expect(answer.status).toBe(200);
  const reasons = harness.logs.slice(before).filter(entry => entry.outcome === "rejected").flatMap(entry => (entry.detail ?? "").split("; "));
  return { accepted: (answer.body as { acked: string[] }).acked, rejected: reasons.map(reason => ({ id: null, reason })) };
}

describe("hub connectors reject what is not theirs", () => {
  it("rejects a GitLab-forge event on the GitHub Event connector", async () => {
    await ready;
    const [fixture] = validFixtures();
    const event = asForge(fixture!.event, "github-event", "gitlab") as { id: string };
    const before = harness.logs.length;
    const answer = await postBatch(harness, "github-event", [event]);
    expect(answer.body).toEqual({ acked: [], rejected: [event.id] });
    expect(harness.logs.slice(before)).toEqual([{ connector: "github-event", outcome: "rejected", count: 1, detail: "subject.forge is gitlab, expected github" }]);
  });

  it("rejects an event whose source.connector is another connector", async () => {
    await ready;
    const [fixture] = validFixtures();
    const event = asForge(fixture!.event, "gitlab-event", "github") as { id: string };
    const before = harness.logs.length;
    const answer = await postBatch(harness, "github-event", [event]);
    expect(answer.body).toEqual({ acked: [], rejected: [event.id] });
    expect(harness.logs.slice(before)[0]?.detail).toBe("source.connector is gitlab-event, expected github-event");
  });

  it("rejects the pr-event v1 items the hub sends today with the validator's own reason", async () => {
    await ready;
    const fixture = invalidFixtures().find(item => item.name === "pr-event-v1-item")!;
    const before = harness.logs.length;
    const answer = await postBatch(harness, "github-event", [fixture.event]);
    expect(answer.body).toEqual({ acked: [], rejected: ["github:delivery-0001:0"] });
    expect(harness.logs.slice(before)).toEqual([{ connector: "github-event", outcome: "rejected", count: 1, detail: fixture.reason }]);
  });
});
