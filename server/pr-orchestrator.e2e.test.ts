// A real server with an empty data folder of its own; the hub is played by signed requests to the webhook listener.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { invalidFixtures, validFixtures } from "./pr-orchestrator/contract/conformance/index.ts";
import { signBatch } from "./pr-orchestrator/signature.ts";

const HUB_KEY = "fake-hub-key-for-end-to-end-tests-0123456789";
const PR_KEY = "github:acme/widgets#42";
const ENABLED_ONLY = { enabled: true };
const GITHUB_ENABLED = { enabled: true, connectors: { "github-event": { use: "github-event", enabled: true } }, routines: { useDefaults: true } };

let fixture: VerificationServer;
let url: string;
let hooks: string;
let dataDir: string;

const fixtureEvent = (type: string): any => structuredClone(validFixtures().find(item => item.type === type)!.event);

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
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function sendBatch(events: unknown[], options: { key?: string; timestamp?: string } = {}): Promise<{ status: number; body: any }> {
  const body = JSON.stringify({ v: 1, events });
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const response = await fetch(`${hooks}/events/github-event`, {
    method: "POST", body, signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "x-omb-timestamp": timestamp, "x-omb-signature": signBatch(Buffer.from(options.key ?? HUB_KEY), timestamp, Buffer.from(body)) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const connector = async (id: string) => (await api("GET", "/api/pr-orchestrator/connectors")).body.connectors.find((item: any) => item.id === id);
const ledgerOf = async () => (await api("GET", `/api/pr-orchestrator/pr?key=${encodeURIComponent(PR_KEY)}`)).body;

beforeAll(async () => {
  fixture = await launchVerificationServer();
  ({ url, dataDir } = fixture.info);
  hooks = `http://127.0.0.1:${Number(new URL(url).port) + 1}`;
  mkdirSync(dataDir, { recursive: true });
}, 60_000);
afterAll(async () => { await fixture?.close(); });

describe("PR orchestrator over the webhook listener", () => {
  it("hides the door until a config file exists", async () => {
    expect((await sendBatch([fixtureEvent("pr.opened")])).status).toBe(404);
    expect((await api("GET", "/api/pr-orchestrator/status")).body).toEqual({ enabled: false, configured: false });
  });

  it("hides a disabled connector", async () => {
    writeConfig(ENABLED_ONLY);
    expect((await sendBatch([fixtureEvent("pr.opened")])).status).toBe(404);
  });

  it("answers 503 while the hub secret is not saved", async () => {
    writeConfig(GITHUB_ENABLED);
    expect((await sendBatch([fixtureEvent("pr.opened")])).status).toBe(503);
  });

  it("acks a signed batch once and shows the PR in the ledger", async () => {
    expect((await api("PUT", "/api/pr-orchestrator/connectors/github-event", { enabled: true, secret: HUB_KEY })).status).toBe(200);
    const first = await sendBatch([fixtureEvent("pr.opened")]);
    expect(first).toMatchObject({ status: 200, body: { rejected: [] } });
    expect(first.body.acked).toHaveLength(1);
    expect(await sendBatch([fixtureEvent("pr.opened")])).toEqual(first);

    await expect.poll(async () => (await ledgerOf())?.record?.state, { timeout: 15_000 }).toBe("ci_running");
    const pr = await ledgerOf();
    expect(pr.ledger.filter((row: any) => row.entry.type === "event.received")).toHaveLength(1);

    const hub = await connector("github-event");
    expect(hub).toMatchObject({ secretPresent: true, intakePath: "/events/github-event", status: { events24h: 1 } });
    expect(hub.status.lastEventAt).toEqual(expect.any(Number));
    expect(JSON.stringify(hub)).not.toContain(HUB_KEY);
  });

  it("rejects a GitLab-forge event sent to the GitHub Event connector", async () => {
    const event = fixtureEvent("pr.opened");
    event.id = "github:delivery-9001:0";
    event.subject.forge = "gitlab";
    const answer = await sendBatch([event]);
    expect(answer.status).toBe(200);
    expect(answer.body.acked).toEqual([]);
    expect(answer.body.rejected).toHaveLength(1);
    expect((await ledgerOf()).ledger.filter((row: any) => row.entry.type === "event.received")).toHaveLength(1);
  });

  it("rejects the pr-event v1 items the hub sends today, with a reason in the connector status", async () => {
    const { event: legacy, reason } = invalidFixtures().find(item => item.name === "pr-event-v1-item")!;
    const answer = await sendBatch([legacy]);
    expect(answer.body.acked).toEqual([]);
    expect(answer.body.rejected).toHaveLength(1);
    expect((await connector("github-event")).status.lastError).toBe(reason);
  });

  it("answers 401 to a bad signature and stores nothing", async () => {
    const before = (await ledgerOf()).ledger.length;
    const event = fixtureEvent("pr.pushed");
    event.id = "github:delivery-9002:0";
    expect((await sendBatch([event], { key: "another-key-than-the-saved-one-0123456" })).status).toBe(401);
    expect((await sendBatch([event], { timestamp: String(Math.floor(Date.now() / 1000) - 3_600) })).status).toBe(401);
    expect((await ledgerOf()).ledger).toHaveLength(before);
    expect((await connector("github-event")).status.signatureFailures24h).toBeGreaterThanOrEqual(1);
  });

  it("lists the default routines with their sentences and tests one on the stored event", async () => {
    const routines = (await api("GET", "/api/pr-orchestrator/routines")).body.routines;
    const ids = routines.map((routine: any) => routine.id);
    expect(ids).toContain("run-ci-fix-workflow");
    expect(routines.every((routine: any) => typeof routine.describe === "string" && routine.describe.length > 0)).toBe(true);

    const pr = await ledgerOf();
    const input = pr.ledger.find((row: any) => row.causationSeq === null);
    const tested = await api("POST", "/api/pr-orchestrator/routines/test", { routineId: "run-ci-fix-workflow", prKey: PR_KEY, inputSeq: input.seq });
    expect(tested).toMatchObject({ status: 200, body: { matched: false } });
    expect((await ledgerOf()).ledger).toHaveLength(pr.ledger.length);
  });

  it("keeps the webhook receiver's own paths working", async () => {
    const unknown = await fetch(`${hooks}/hooks/wh_unknown`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(unknown.status).toBe(401);
    expect((await fetch(`${hooks}/health`)).status).toBe(200);
    expect((await fetch(`${hooks}/events/not-a-connector`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});
