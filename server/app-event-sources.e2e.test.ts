import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { validFixtures } from "./pr-orchestrator/contract/conformance/index.ts";
import { signBatch } from "./pr-orchestrator/signature.ts";

const HUB_KEY = "fake-hub-key-for-event-source-tests-0123456789";

let fixture: VerificationServer;
let url: string;
let hooks: string;
let dataDir: string;

beforeAll(async () => {
  fixture = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true });
  ({ url, dataDir } = fixture.info);
  hooks = `http://127.0.0.1:${Number(new URL(url).port) + 1}`;
  mkdirSync(dataDir, { recursive: true });
}, 60_000);

afterAll(async () => { await fixture?.close(); });

function writeConfig(): void {
  const path = join(dataDir, "pr-orchestrator.json");
  writeFileSync(path, JSON.stringify({ enabled: true, connectors: { "github-event": { use: "github-event", enabled: true } } }));
  const past = new Date(Date.now() - 3_000);
  utimesSync(path, past, past);
}

async function api(method: string, path: string, body?: unknown, status = 200) {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json() as { error?: string; triggers?: Array<Record<string, unknown>>; runs?: Array<Record<string, unknown>> };
  expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
  return value;
}

async function sendCi(id: string): Promise<void> {
  const event = structuredClone(validFixtures().find((item) => item.type === "pr.ci.finished")!.event) as { id: string };
  event.id = id;
  const body = JSON.stringify({ v: 1, events: [event] });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(`${hooks}/events/github-event`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "x-omb-timestamp": timestamp, "x-omb-signature": signBatch(Buffer.from(HUB_KEY), timestamp, Buffer.from(body)) },
  });
  expect(response.status).toBe(200);
}

it("a signed CI batch for a watched repo starts one run of the bot that owns the automation", async () => {
  writeConfig();
  expect((await api("PUT", "/api/pr-orchestrator/connectors/github-event", { enabled: true, secret: HUB_KEY }, 200)).error).toBeUndefined();
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<{ bot: { id: string } }>;
  const { bot } = await cli("new-bot", "--name", "Scout");
  const made = await api("POST", "/api/app-triggers", {
    botId: bot.id, name: "Valid PRs", prompt: "Merge valid pull requests.", app: "github-event", event: "pull_request",
    config: { types: "pr.ci.finished", repos: "acme/*" },
  }, 201) as { trigger: { id: string; botId: string; runOn: string; remote: { triggerId?: string; state: string } } };
  expect(made.trigger).toMatchObject({ botId: bot.id, runOn: "maus", remote: { state: "active" } });
  expect(made.trigger.remote.triggerId).toBeUndefined();
  await sendCi("github:delivery-event-source:0");
  await expect.poll(async () => {
    const snapshot = await api("GET", "/api/app-triggers");
    return snapshot.triggers?.find((trigger) => trigger.id === made.trigger.id)?.received;
  }, { timeout: 20_000 }).toBe(1);
  const runs = await api("GET", "/api/routines");
  const owned = (runs.runs ?? []).filter((run) => run.routineId === made.trigger.id);
  expect(owned).toHaveLength(1);
  expect(owned[0]).toMatchObject({ botId: bot.id, eventSource: "app" });
}, 60_000);

it("the trigger tool creates a GitHub Event automation for the bot", async () => {
  const planPath = join(dataDir, "room-plan.json");
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<{ bot: { id: string; activeTaskId: string } }>;
  const { bot } = await cli("new-bot", "--name", "Merger");
  writeFileSync(planPath, JSON.stringify({
    [bot.id]: {
      steps: [{
        tool: "create_trigger",
        arguments: {
          when: "app_event", name: "Merge valid PRs", app: "github-event", event: "pull_request",
          event_config: { types: "pr.ci.finished", repos: "acme/*" },
          instructions: "Merge the pull request when it is valid.",
        },
      }],
      reply: "The automation is ready.",
    },
  }));
  await cli("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Watch pull requests in acme and merge the valid ones.");
  await cli("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "30");
  const snapshot = await api("GET", "/api/app-triggers");
  const made = snapshot.triggers?.find((trigger) => trigger.botId === bot.id && trigger.app === "github-event");
  expect(made).toMatchObject({
    event: "pull_request", runOn: "maus", enabled: true,
    config: { types: ["pr.ci.finished"], repos: ["acme/*"], authors: [] },
    remote: { state: "active" },
  });
  const remote = made!.remote as { triggerId?: string };
  expect(remote.triggerId).toBeUndefined();
}, 60_000);
