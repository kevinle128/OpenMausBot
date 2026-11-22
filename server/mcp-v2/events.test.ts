import { afterEach, beforeEach, expect, it } from "vitest";
import { openMcpV2 } from "./client.ts";
import { FAKE_EVENT_NAME, startFakeV2Server, type FakeV2Server } from "./testing/fake-v2-server.ts";
import type { McpEvent, McpV2Connection } from "./types.ts";

let fake: FakeV2Server;
let connection: McpV2Connection;

beforeEach(async () => {
  fake = await startFakeV2Server();
  connection = await openMcpV2({ url: fake.url, headers: { authorization: "Bearer test-key" } });
});

afterEach(async () => {
  await connection.close();
  await fake.close();
});

function listener(count: number): { events: McpEvent[]; reached: Promise<void>; onEvent(event: McpEvent): void } {
  const events: McpEvent[] = [];
  let reach: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  return {
    events,
    reached,
    onEvent(event) {
      events.push(event);
      if (events.length >= count) reach();
    },
  };
}

it("lists event types with their schemas", async () => {
  expect(await connection.listEvents()).toEqual([
    {
      name: FAKE_EVENT_NAME,
      description: "A run changed status",
      delivery: ["poll", "push"],
      inputSchema: { type: "object" },
      payloadSchema: { type: "object" },
    },
  ]);
});

it("polls from now and then from the returned cursor", async () => {
  fake.appendEvent({ run_id: "run-1", status: "running" });
  const fromNow = await connection.pollEvents({ name: FAKE_EVENT_NAME, cursor: null });
  expect(fromNow).toEqual({ events: [], cursor: "v1:1" });

  fake.appendEvent({ run_id: "run-1", status: "paused" });
  fake.appendEvent({ run_id: "run-1", status: "completed" });
  const next = await connection.pollEvents({ name: FAKE_EVENT_NAME, arguments: { run_id: "run-1" }, cursor: fromNow.cursor });
  expect(next.cursor).toBe("v1:3");
  expect(next.events.map((event) => event.data)).toEqual([
    { run_id: "run-1", status: "paused" },
    { run_id: "run-1", status: "completed" },
  ]);
  const poll = fake.requests.filter((request) => request.method === "events/poll").at(-1);
  expect(poll?.headers["mcp-name"]).toBe(FAKE_EVENT_NAME);
  expect(poll?.params.arguments).toEqual({ run_id: "run-1" });
  expect(poll?.headers.authorization).toBe("Bearer test-key");
});

it("streams events and heartbeats and returns the last cursor when the stream closes", async () => {
  const seen = listener(2);
  const heartbeats: string[] = [];
  const ending = connection.streamEvents({
    name: FAKE_EVENT_NAME,
    cursor: null,
    signal: new AbortController().signal,
    onEvent: seen.onEvent,
    onHeartbeat: (cursor) => heartbeats.push(cursor),
  });
  await fake.waitForStreams(1);
  fake.appendEvent({ status: "running" });
  fake.appendEvent({ status: "completed" });
  await seen.reached;
  fake.sendHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 20));
  fake.endStreams();
  expect(await ending).toEqual({ cursor: "v1:2", reason: "closed" });
  expect(seen.events.map((event) => event.eventId)).toEqual(["run-1:1", "run-1:2"]);
  expect(heartbeats).toEqual(["v1:2"]);
});

it("resumes a stream from a stored cursor without losing or repeating an event", async () => {
  const first = listener(2);
  const firstEnd = connection.streamEvents({ name: FAKE_EVENT_NAME, cursor: null, signal: new AbortController().signal, onEvent: first.onEvent });
  await fake.waitForStreams(1);
  fake.appendEvent({ n: 1 });
  fake.appendEvent({ n: 2 });
  await first.reached;
  fake.endStreams();
  const dropped = await firstEnd;
  expect(dropped).toEqual({ cursor: "v1:2", reason: "closed" });

  fake.appendEvent({ n: 3 });
  const second = listener(3);
  const secondEnd = connection.streamEvents({ name: FAKE_EVENT_NAME, cursor: dropped.cursor, signal: new AbortController().signal, onEvent: second.onEvent });
  await fake.waitForStreams(1);
  fake.appendEvent({ n: 4 });
  fake.appendEvent({ n: 5 });
  await second.reached;
  fake.endStreams();
  await secondEnd;

  const all = [...first.events, ...second.events].map((event) => (event.data as { n: number }).n);
  expect(all).toEqual([1, 2, 3, 4, 5]);
});

it("stops a stream on abort", async () => {
  const controller = new AbortController();
  const ending = connection.streamEvents({ name: FAKE_EVENT_NAME, cursor: "v1:0", signal: controller.signal, onEvent: () => undefined });
  await fake.waitForStreams(1);
  controller.abort();
  expect(await ending).toEqual({ cursor: "v1:0", reason: "aborted" });
});

it("reports a server error for an unknown event name", async () => {
  await expect(connection.pollEvents({ name: "nope", cursor: null })).rejects.toThrow(/Unknown event/);
  const end = await connection.streamEvents({ name: "nope", cursor: null, signal: new AbortController().signal, onEvent: () => undefined });
  expect(end).toMatchObject({ reason: "error", error: expect.stringContaining("Unknown event") });
});
