// A real server with an empty data folder of its own; the hub is played by signed requests to the webhook listener.
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { validFixtures } from "./pr-orchestrator/contract/conformance/index.ts";
import { signBatch } from "./pr-orchestrator/signature.ts";

const HUB_KEY = "fake-hub-key-for-end-to-end-tests-0123456789";
const PR_KEY = "github:acme/widgets#42";
const CHOICES = ["Fix it as the review proposes", "Leave it as it is", "Stop and wait for me"];

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

async function sendBatch(events: unknown[]): Promise<{ status: number; body: any }> {
  const body = JSON.stringify({ v: 1, events });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(`${hooks}/events/github-event`, {
    method: "POST", body, signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "x-omb-timestamp": timestamp, "x-omb-signature": signBatch(Buffer.from(HUB_KEY), timestamp, Buffer.from(body)) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const ledgerOf = async () => (await api("GET", `/api/pr-orchestrator/pr?key=${encodeURIComponent(PR_KEY)}`)).body;
const askRows = async () => (await api("GET", "/api/inbox")).body.rows.filter((row: any) => row.tab === "needs-you" && row.from.name === "Pull requests");

beforeAll(async () => {
  fixture = await launchVerificationServer();
  ({ url, dataDir } = fixture.info);
  hooks = `http://127.0.0.1:${Number(new URL(url).port) + 1}`;
  mkdirSync(dataDir, { recursive: true });
}, 60_000);
afterAll(async () => { await fixture?.close(); });

describe("PR orchestrator Inbox notifier", () => {
  it("asks the person in the Inbox when a review needs a decision and records the answer", async () => {
    writeConfig({ enabled: true, connectors: { "github-event": { use: "github-event", enabled: true } }, adapters: { notifier: { enabled: true } } });
    expect((await api("POST", "/api/vault/secrets", { name: "GITHUB_EVENT_HUB_SECRET", value: HUB_KEY })).status).toBe(201);
    expect((await sendBatch([fixtureEvent("pr.opened"), fixtureEvent("pr.review.finished")])).status).toBe(200);

    await expect.poll(askRows, { timeout: 20_000 }).toHaveLength(1);
    const [row] = await askRows();
    expect(row.card).toMatchObject({ requestType: "question", options: CHOICES });

    expect((await ledgerOf()).record.state).toBe("needs_decision");
    const tapped = await api("POST", `/api/bots/pr-orchestrator/respond`, { requestId: row.card.requestId, behavior: "answer", message: CHOICES[1] });
    expect(tapped).toMatchObject({ status: 200, body: { ok: true, outcome: "answered" } });

    await expect.poll(async () => (await ledgerOf()).record?.lastAnswer?.answer, { timeout: 15_000 }).toBeDefined();
    const pr = await ledgerOf();
    expect(pr.ledger.some((entry: any) => entry.entry.type === "person.answered")).toBe(true);
    expect(pr.record.lastAnswer.answer).toContain(CHOICES[1]);
    expect(pr.record.state).not.toBe("needs_decision");
    expect(await askRows()).toHaveLength(0);
  });
});
