// A real server with an empty data folder of its own; the hub is played by signed requests to the webhook listener.
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { validFixtures } from "./pr-orchestrator/contract/conformance/index.ts";
import { signBatch } from "./pr-orchestrator/signature.ts";

const HUB_KEY = "fake-hub-key-for-connector-settings-tests-9876543210";
const SECRET_NAME = "GITHUB_EVENT_HUB_SECRET";
const CONNECTORS = "/api/pr-orchestrator/connectors";

let fixture: VerificationServer;
let url: string;
let hooks: string;
let dataDir: string;
const responses: string[] = [];

/** The server trusts a config file only once its mtime is two seconds old, so the file is dated into the past. */
function writeConfig(config: unknown): void {
  const path = join(dataDir, "pr-orchestrator.json");
  writeFileSync(path, JSON.stringify(config));
  const past = new Date(Date.now() - 3_000);
  utimesSync(path, past, past);
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  responses.push(text);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function sendBatch(target: string, events: unknown[], key = HUB_KEY): Promise<{ status: number; body: any }> {
  const body = JSON.stringify({ v: 1, events });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(target, {
    method: "POST", body, signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "x-omb-timestamp": timestamp, "x-omb-signature": signBatch(Buffer.from(key), timestamp, Buffer.from(body)) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const opened = () => structuredClone(validFixtures().find(item => item.type === "pr.opened")!.event);
const connector = async (id: string) => (await api("GET", CONNECTORS)).body.connectors.find((item: any) => item.id === id);

beforeAll(async () => {
  fixture = await launchVerificationServer();
  ({ url, dataDir } = fixture.info);
  hooks = `http://127.0.0.1:${Number(new URL(url).port) + 1}`;
  mkdirSync(dataDir, { recursive: true });
  writeConfig({ enabled: true });
}, 60_000);
afterAll(async () => { await fixture?.close(); });

describe("event connector settings over the API", () => {
  it("enables GitHub Event through the API and then accepts a signed batch at its intake URL", async () => {
    const before = await connector("github-event");
    expect(before).toMatchObject({ enabled: false, secretName: SECRET_NAME, secretPresent: false });
    expect(before.intakeUrl).toBe(`${hooks}/events/github-event`);
    expect((await sendBatch(before.intakeUrl, [opened()])).status).toBe(404);

    const changed = await api("PUT", `${CONNECTORS}/github-event`, { enabled: true });
    expect(changed).toMatchObject({ status: 200, body: { id: "github-event", enabled: true, intakeUrl: before.intakeUrl } });
    const path = join(dataDir, "pr-orchestrator.json");
    expect(JSON.parse(readFileSync(path, "utf8")).connectors["github-event"]).toEqual({ use: "github-event", enabled: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await sendBatch(before.intakeUrl, [opened()])).status).toBe(503);

    expect((await api("PUT", `${CONNECTORS}/github-event`, { enabled: true, secret: HUB_KEY })).status).toBe(200);
    expect(await connector("github-event")).toMatchObject({ secretPresent: true });
    const accepted = await sendBatch(before.intakeUrl, [opened()]);
    expect(accepted).toMatchObject({ status: 200, body: { rejected: [] } });
    expect(accepted.body.acked).toHaveLength(1);
    expect(await connector("github-event")).toMatchObject({ status: { events24h: 1 } });

    expect((await api("PUT", `${CONNECTORS}/github-event`, { enabled: false, secret: "" })).body).toMatchObject({ enabled: false, secretPresent: false });
    expect((await sendBatch(before.intakeUrl, [opened()])).status).toBe(404);
  });

  it("saves settings and refuses ones the connector rejects", async () => {
    expect((await api("PUT", `${CONNECTORS}/gitlab-event`, { settings: { toleranceSeconds: 120 } })).body.settings).toEqual({ toleranceSeconds: 120 });
    const refused = await api("PUT", `${CONNECTORS}/gitlab-event`, { settings: { toleranceSeconds: 1 } });
    expect(refused.status).toBe(400);
    expect((await connector("gitlab-event")).settings).toEqual({ toleranceSeconds: 120 });
    expect((await api("PUT", `${CONNECTORS}/nope`, { enabled: true })).status).toBe(404);
  });

  it("never returns a secret value in any connector response", async () => {
    await api("PUT", `${CONNECTORS}/github-event`, { enabled: true, secret: HUB_KEY });
    await api("GET", CONNECTORS);
    await api("GET", "/api/pr-orchestrator/status");
    await api("GET", "/api/pr-orchestrator/config");
    await sendBatch(`${hooks}/events/github-event`, [opened()], "another-wrong-key-0123456789abcdef");
    await api("GET", CONNECTORS);
    expect(responses.length).toBeGreaterThan(8);
    expect(responses.filter(text => text.includes(HUB_KEY))).toEqual([]);
    expect(readFileSync(join(dataDir, "pr-orchestrator.json"), "utf8")).not.toContain(HUB_KEY);
  });
});

describe("event intake follows the connectors, not a top-level switch", () => {
  const github = () => `${hooks}/events/github-event`;
  const gitlab = () => `${hooks}/events/gitlab-event`;

  it("accepts a signed batch when only GitHub Event is on and the top-level flag is absent", async () => {
    writeConfig({ connectors: { "github-event": { use: "github-event", enabled: true } } });
    expect((await sendBatch(github(), [opened()])).status).toBe(200);
    expect((await api("GET", "/api/pr-orchestrator/status")).body).toMatchObject({ enabled: true, configured: true });
  });

  it("keeps GitLab Event closed while only GitHub Event is on", async () => {
    expect((await sendBatch(gitlab(), [opened()])).status).toBe(404);
  });

  it("answers 404 again after the last connector is turned off", async () => {
    expect((await api("PUT", `${CONNECTORS}/github-event`, { enabled: false })).status).toBe(200);
    expect((await sendBatch(github(), [opened()])).status).toBe(404);
    expect((await api("GET", "/api/pr-orchestrator/status")).body).toMatchObject({ enabled: false });
  });

  it("opens only the connector that was turned on", async () => {
    expect((await api("PUT", `${CONNECTORS}/gitlab-event`, { enabled: true })).status).toBe(200);
    expect((await sendBatch(github(), [opened()])).status).toBe(404);
    expect((await sendBatch(gitlab(), [opened()])).status).toBe(503);
  });

  it("keeps a file with the top-level flag true working", async () => {
    writeConfig({ enabled: true, connectors: { "github-event": { use: "github-event", enabled: true } } });
    expect((await sendBatch(github(), [opened()])).status).toBe(200);
  });
});
