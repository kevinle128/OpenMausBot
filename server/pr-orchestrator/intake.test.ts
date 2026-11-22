import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { validFixtures } from "./contract/conformance/index.ts";
import { githubEvent } from "./connectors/github-event.ts";
import { MAX_EVENTS_BODY_BYTES, createEventsDoor, conformItems } from "./intake.ts";
import { TEST_TYPE, chatEvent, testHook, withTestTypes } from "./testing/fake-connectors.ts";
import { FAKE_HUB_KEY, NOW_MS, hubInstances, postBatch, signedHeaders, startDoor, type DoorHarness } from "./testing/door-harness.ts";
import { createWebhookIngressHandler, json } from "../webhook-ingress.ts";
import type { WebhookManager } from "../webhooks.ts";

const open: DoorHarness[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map(harness => harness.close()));
  servers.splice(0).forEach(server => server.closeAllConnections());
});
async function door(...args: Parameters<typeof startDoor>): Promise<DoorHarness> {
  const harness = await startDoor(...args);
  open.push(harness);
  return harness;
}
const github = () => validFixtures().map(fixture => fixture.event as { id: string });
const raw = (harness: DoorHarness, path: string, init: RequestInit) => fetch(`${harness.base}${path}`, init);

describe("events door", () => {
  it("answers 404 for an unknown or disabled connector, so nothing reveals the door", async () => {
    const off = await door({ enabled: () => false });
    expect((await postBatch(off, "github-event", github())).status).toBe(404);
    const harness = await door({}, { "github-event": { ...hubInstances()["github-event"]! } });
    expect((await postBatch(harness, "gitlab-event", github())).status).toBe(404);
    expect((await postBatch(harness, "Not_Valid", github())).status).toBe(404);
    const missing = await door({ instance: () => null });
    expect((await postBatch(missing, "github-event", github())).status).toBe(404);
    expect(off.batches.length + harness.batches.length + missing.batches.length).toBe(0);
  });

  it("answers 404 for a connector that is not inbound-http", async () => {
    const harness = await door({}, { "github-event": { definition: { ...githubEvent, delivery: "subscription" }, settings: {}, secretName: "S" } });
    expect((await postBatch(harness, "github-event", github())).status).toBe(404);
  });

  it("answers 405 for a method other than POST", async () => {
    const harness = await door();
    expect((await raw(harness, "/events/github-event", { method: "GET" })).status).toBe(405);
  });

  it("acks every conforming event of a signed batch and hands them to the core once", async () => {
    const harness = await door();
    const events = github();
    const answer = await postBatch(harness, "github-event", events);
    expect(answer).toEqual({ status: 200, body: { acked: events.map(event => event.id), rejected: [] } });
    expect(harness.batches).toHaveLength(1);
    const [first] = harness.batches[0]!;
    expect(first!.event).toMatchObject({ connector: "github-event", key: `github-event:${events[0]!.id}`, rawRef: null });
    expect(first!.event.subjectKey).toBe("github:acme/widgets#42");
    expect(JSON.parse(first!.raw)).toEqual(events[0]);
    expect(harness.logs).toEqual([{ connector: "github-event", outcome: "accepted", count: events.length }]);
  });

  it("acks an event that is already stored as taken", async () => {
    const harness = await door();
    const events = github();
    await postBatch(harness, "github-event", events);
    const again = await postBatch(harness, "github-event", events);
    expect(again.body).toEqual({ acked: events.map(event => event.id), rejected: [] });
    expect(harness.stored.size).toBe(events.length);
    expect(harness.logs.at(-1)).toEqual({ connector: "github-event", outcome: "duplicate", count: events.length });
  });

  it("names a repeated id once in the answer", async () => {
    const harness = await door();
    const [one] = github();
    const answer = await postBatch(harness, "github-event", [one, one]);
    expect(answer.body).toEqual({ acked: [one!.id], rejected: [] });
  });

  it("rejects a non-conforming event with its reason, logs it and never hands it to the core", async () => {
    const harness = await door();
    const [good, other] = github();
    const broken = { ...other, data: {} };
    const noId = { v: 1 };
    const answer = await postBatch(harness, "github-event", [good, broken, noId, "text"]);
    expect(answer.status).toBe(200);
    expect((answer.body as { acked: string[] }).acked).toEqual([good!.id]);
    expect((answer.body as { rejected: string[] }).rejected).toEqual([broken.id]);
    expect(harness.batches.flat().map(item => item.event.id)).toEqual([good!.id]);
    const rejected = harness.logs.find(entry => entry.outcome === "rejected")!;
    expect(rejected.count).toBe(3);
    expect(rejected.detail!.split("; ")).toHaveLength(3);
  });

  it("does not call the core when no item conforms", async () => {
    const harness = await door();
    expect((await postBatch(harness, "github-event", [{}])).body).toEqual({ acked: [], rejected: [] });
    expect(harness.batches).toEqual([]);
  });

  it("answers 401 for a bad signature, logs a signature failure and never calls the core", async () => {
    const harness = await door();
    const body = JSON.stringify({ v: 1, events: github() });
    const other = Buffer.from("another-fake-key-for-tests-only-99");
    const answer = await raw(harness, "/events/github-event", { method: "POST", headers: signedHeaders(body, { key: other }), body });
    expect(answer.status).toBe(401);
    const tampered = await raw(harness, "/events/github-event", { method: "POST", headers: signedHeaders(body), body: `${body} ` });
    expect(tampered.status).toBe(401);
    expect(harness.batches).toEqual([]);
    expect(harness.logs.map(entry => entry.outcome)).toEqual(["bad_signature", "bad_signature"]);
    expect(JSON.stringify(harness.logs) + harness.lines.join()).not.toContain(FAKE_HUB_KEY.toString());
  });

  it("answers 401 for an old timestamp before reading the body", async () => {
    const harness = await door();
    const body = JSON.stringify({ v: 1, events: github() });
    const stale = String(Math.floor(NOW_MS / 1000) - 3600);
    const headers = { ...signedHeaders(body, { timestamp: stale }), "content-length": String(Buffer.byteLength(body)) };
    expect((await raw(harness, "/events/github-event", { method: "POST", headers, body })).status).toBe(401);
    expect(harness.logs).toEqual([{ connector: "github-event", outcome: "bad_signature", count: 1, detail: "timestamp outside the tolerance" }]);
    const missing = await raw(harness, "/events/github-event", { method: "POST", body });
    expect(missing.status).toBe(401);
  });

  it("answers 503 when the connector's secret is not saved", async () => {
    const harness = await door({ key: () => null });
    expect((await postBatch(harness, "github-event", github())).status).toBe(503);
    expect(harness.logs).toEqual([{ connector: "github-event", outcome: "error", count: 1, detail: "the connector's secret is not in the Vault" }]);
    expect(harness.batches).toEqual([]);
  });

  it("answers 503 when the core cannot store the batch, so the hub sends it again", async () => {
    const harness = await door({ sink: { accept() { throw new Error("disk full"); } } });
    const answer = await postBatch(harness, "github-event", github());
    expect(answer.status).toBe(503);
    expect(harness.logs.map(entry => entry.outcome)).toEqual(["error"]);
    expect(harness.lines.join()).toContain("disk full");
  });

  it("answers 413 for a body over the limit", async () => {
    const harness = await door();
    const body = JSON.stringify({ v: 1, events: [], pad: "x".repeat(MAX_EVENTS_BODY_BYTES) });
    const answer = await raw(harness, "/events/github-event", { method: "POST", headers: signedHeaders(body), body });
    expect(answer.status).toBe(413);
    expect(harness.batches).toEqual([]);
  });

  it("answers 400 for a body that is not a v1 batch", async () => {
    const harness = await door();
    expect((await postBatch(harness, "github-event", [], { v: 2 })).status).toBe(400);
    for (const body of ["not json", JSON.stringify({ v: 1 }), JSON.stringify([])]) {
      const answer = await raw(harness, "/events/github-event", { method: "POST", headers: signedHeaders(body), body });
      expect(answer.status).toBe(400);
    }
    expect(harness.logs.every(entry => entry.outcome === "bad_request")).toBe(true);
    expect(harness.batches).toEqual([]);
  });

  it("releases the maintenance claim on every path", async () => {
    let claimed = 0, released = 0;
    const claimRequest = () => { claimed += 1; return () => { released += 1; }; };
    const harness = await door({ claimRequest });
    const body = JSON.stringify({ v: 1, events: github() });
    await postBatch(harness, "github-event", github());
    await postBatch(harness, "github-event", github(), { key: Buffer.from("another-fake-key-for-tests-only-99") });
    await raw(harness, "/events/github-event", { method: "POST", headers: signedHeaders("nope"), body: "nope" });
    await raw(harness, "/events/github-event", { method: "POST", headers: signedHeaders(body, { timestamp: "1" }), body });
    expect(claimed).toBe(4);
    expect(released).toBe(4);
    const throwing = await door({ claimRequest: () => { throw new Error("This Cloud moved"); } });
    expect((await postBatch(throwing, "github-event", github())).status).toBe(503);
    const failing = await door({ claimRequest, sink: { accept() { throw new Error("boom"); } } });
    await postBatch(failing, "github-event", github());
    expect(claimed).toBe(released);
  });

  it("lets other doors answer their own paths", async () => {
    const harness = await door();
    expect((await raw(harness, "/health", {})).status).toBe(200);
    const other = await door({}, hubInstances());
    expect((await raw(other, "/events/github-event/extra", { method: "POST" })).status).toBe(404);
    const chained = createServer((req, res) => {
      const events = createEventsDoor({ ...baseDeps(), instance: () => null });
      void createWebhookIngressHandler({} as WebhookManager, undefined, async (rq, rs, url) => (await events(rq, rs, url)) || (url.pathname === "/api/other" && (json(rs, 200, { other: true }), true)))(req, res);
    });
    servers.push(chained);
    await new Promise<void>(resolve => chained.listen(0, "127.0.0.1", resolve));
    const answer = await fetch(`http://127.0.0.1:${(chained.address() as { port: number }).port}/api/other`);
    expect(await answer.json()).toEqual({ other: true });
  });
});

function baseDeps(): Parameters<typeof createEventsDoor>[0] {
  return { enabled: () => true, instance: () => null, key: () => null, sink: { accept: () => ({ stored: 0, duplicates: 0 }) }, log: () => {}, logLine: () => {} };
}

describe("a connector that only a test registers", () => {
  const { validator } = withTestTypes();
  const hookKey = Buffer.from("fake-hook-key-for-tests-only-0123");
  const instances = { "test-hook": { definition: testHook as never, settings: {}, secretName: "TEST_HOOK_SECRET" } };

  it("serves a fake connector registered only in the test with its own auth and answer", async () => {
    const harness = await door({ validator, key: () => hookKey }, instances);
    const post = (token: string, event: unknown) => raw(harness, "/events/test-hook", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(event) });
    const event = chatEvent("test-hook", "m1");
    const answer = await post(hookKey.toString(), event);
    expect(answer.status).toBe(202);
    expect(await answer.json()).toEqual({ taken: 1 });
    expect(harness.batches[0]![0]!.event).toMatchObject({ key: "test-hook:m1", subjectKey: "subject:test-hook:thread:thread-1", type: TEST_TYPE });
    expect((await post("wrong", event)).status).toBe(401);
    const bad = await post(hookKey.toString(), { ...event, data: { text: 1 } });
    expect(await bad.json()).toEqual({ taken: 0 });
    expect(harness.logs.at(-1)).toMatchObject({ outcome: "rejected" });
  });

  it("refuses the test type when the shipped validator is used", async () => {
    const harness = await door({ key: () => hookKey }, instances);
    const answer = await raw(harness, "/events/test-hook", { method: "POST", headers: { authorization: `Bearer ${hookKey.toString()}` }, body: JSON.stringify(chatEvent("test-hook", "m2")) });
    expect(await answer.json()).toEqual({ taken: 0 });
    expect(harness.logs.at(-1)?.detail).toBe(`unknown type ${TEST_TYPE}`);
  });
});

describe("conformItems", () => {
  it("builds the stored event from a conforming item and keeps the original text", () => {
    const { validator } = withTestTypes();
    const event = chatEvent("test-hook", "x1");
    const { accepted, rejected } = conformItems([event, { nope: true }], "test-hook", testHook as never, validator);
    expect(rejected).toHaveLength(1);
    expect(accepted[0]!.event.key).toBe("test-hook:x1");
    expect(accepted[0]!.raw).toBe(JSON.stringify(event));
  });
});
