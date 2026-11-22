// A real server whose data folder has never held a config file: the connectors must still be listed and switchable.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { validFixtures } from "./pr-orchestrator/contract/conformance/index.ts";
import { signBatch } from "./pr-orchestrator/signature.ts";

const CONNECTORS = "/api/pr-orchestrator/connectors";
let fixture: VerificationServer;
let url: string;
let hooks: string;
let dataDir: string;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function sendBatch(): Promise<number> {
  const event = structuredClone(validFixtures().find(item => item.type === "pr.opened")!.event);
  const body = JSON.stringify({ v: 1, events: [event] });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(`${hooks}/events/github-event`, {
    method: "POST", body, signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "x-omb-timestamp": timestamp, "x-omb-signature": signBatch(Buffer.from("fresh-install-key-0123456789abcdef"), timestamp, Buffer.from(body)) },
  });
  return response.status;
}

beforeAll(async () => {
  fixture = await launchVerificationServer();
  ({ url, dataDir } = fixture.info);
  hooks = `http://127.0.0.1:${Number(new URL(url).port) + 1}`;
}, 60_000);
afterAll(async () => { await fixture?.close(); });

describe("event connectors on an install with no config file", () => {
  it("lists GitHub Event and GitLab Event as off, with their intake URLs, before any write", async () => {
    expect(existsSync(join(dataDir, "pr-orchestrator.json"))).toBe(false);
    const listed = await api("GET", CONNECTORS);
    expect(listed.status).toBe(200);
    expect(listed.body.connectors.map((item: any) => [item.id, item.enabled, item.status.events24h])).toEqual([["github-event", false, 0], ["gitlab-event", false, 0]]);
    expect(listed.body.connectors[0]).toMatchObject({ intakeUrl: `${hooks}/events/github-event`, secretPresent: false });
    expect(existsSync(join(dataDir, "pr-orchestrator.json"))).toBe(false);
  });

  it("turns GitHub Event on with the first write and opens its intake", async () => {
    expect(await sendBatch()).toBe(404);
    const changed = await api("PUT", `${CONNECTORS}/github-event`, { enabled: true });
    expect(changed).toMatchObject({ status: 200, body: { id: "github-event", enabled: true } });
    expect(await sendBatch()).toBe(503);
  });
});
