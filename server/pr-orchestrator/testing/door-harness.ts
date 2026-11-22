import { createServer, type Server } from "node:http";
import type { ConnectorDefinition } from "../ports.ts";
import { githubEvent } from "../connectors/github-event.ts";
import { gitlabEvent } from "../connectors/gitlab-event.ts";
import { createEventsDoor, type EventsDoorDeps, type IntakeOutcome } from "../intake.ts";
import { signBatch } from "../signature.ts";
import type { AcceptItem } from "../types.ts";
import { createWebhookIngressHandler } from "../../webhook-ingress.ts";
import type { WebhookManager } from "../../webhooks.ts";

/** A fixed fake key; the real one only ever comes from the Vault. */
export const FAKE_HUB_KEY = Buffer.from("fake-hub-key-for-tests-only-0123456789");
export const NOW_MS = Date.parse("2026-11-22T03:00:00Z");

export type Instances = Record<string, { definition: ConnectorDefinition; settings: unknown; secretName: string | null }>;
export interface LogEntry { connector: string; outcome: IntakeOutcome; count: number; detail?: string }

export interface DoorHarness {
  base: string;
  logs: LogEntry[];
  lines: string[];
  /** Every batch that reached the sink. */
  batches: AcceptItem[][];
  stored: Set<string>;
  close(): Promise<void>;
}

export function hubInstances(): Instances {
  return {
    "github-event": { definition: githubEvent as ConnectorDefinition, settings: { toleranceSeconds: 300 }, secretName: "GITHUB_EVENT_HUB_SECRET" },
    "gitlab-event": { definition: gitlabEvent as ConnectorDefinition, settings: { toleranceSeconds: 300 }, secretName: "GITLAB_EVENT_HUB_SECRET" },
  };
}

export async function startDoor(over: Partial<EventsDoorDeps> = {}, instances: Instances = hubInstances()): Promise<DoorHarness> {
  const harness: DoorHarness = { base: "", logs: [], lines: [], batches: [], stored: new Set(), close: async () => {} };
  const door = createEventsDoor({
    enabled: () => true,
    instance: id => instances[id] ?? null,
    key: () => FAKE_HUB_KEY,
    sink: {
      accept(items) {
        harness.batches.push(items);
        let stored = 0, duplicates = 0;
        for (const item of items) {
          if (harness.stored.has(item.event.key)) duplicates += 1;
          else { harness.stored.add(item.event.key); stored += 1; }
        }
        return { stored, duplicates };
      },
    },
    log: entry => harness.logs.push(entry),
    logLine: line => harness.lines.push(line),
    now: () => NOW_MS,
    ...over,
  });
  const server: Server = createServer((req, res) => { void createWebhookIngressHandler({} as WebhookManager, undefined, door)(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  harness.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  harness.close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return harness;
}

export function signedHeaders(body: string, opts: { key?: Buffer; timestamp?: string } = {}): Record<string, string> {
  const timestamp = opts.timestamp ?? String(Math.floor(NOW_MS / 1000));
  return {
    "content-type": "application/json",
    "x-omb-timestamp": timestamp,
    "x-omb-signature": signBatch(opts.key ?? FAKE_HUB_KEY, timestamp, Buffer.from(body)),
  };
}

export async function postBatch(
  harness: DoorHarness, instance: string, events: unknown[], opts: { key?: Buffer; timestamp?: string; v?: number } = {},
): Promise<{ status: number; body: unknown }> {
  const body = JSON.stringify({ v: opts.v ?? 1, events });
  const answer = await fetch(`${harness.base}/events/${instance}`, { method: "POST", headers: signedHeaders(body, opts), body });
  return { status: answer.status, body: await answer.json().catch(() => null) };
}
