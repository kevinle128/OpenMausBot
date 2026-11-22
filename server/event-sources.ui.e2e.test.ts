// The person's journey with an event source app in a real browser against a real server (temporary home, scripted engine):
// turn GitHub Event on from the Apps page, save its key in the Vault, send a signed batch and see its first event.
// Runs where a Chromium and playwright-core are named; without them the test is skipped, never passed:
//   OMB_UI_CHROMIUM=<chrome or headless shell> OMB_UI_PLAYWRIGHT_CORE=<playwright-core dir> OMB_UI_DIST=<vite build dir>
//   [OMB_UI_SHOTS=<folder for screenshots>] vitest run server/event-sources.ui.e2e.test.ts
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WELCOME_VERSION } from "../electron/onboarding-record.mjs";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { validFixtures } from "./pr-orchestrator/contract/conformance/index.ts";
import { signBatch } from "./pr-orchestrator/signature.ts";

const { OMB_UI_CHROMIUM: chromiumPath, OMB_UI_PLAYWRIGHT_CORE: playwrightPath, OMB_UI_DIST: dist } = process.env;
const shots = process.env.OMB_UI_SHOTS ?? join(process.cwd(), "docs", "screenshots", "apps-event-sources");
const ready = Boolean(chromiumPath && playwrightPath && dist);
const HUB_KEY = "fake-hub-key-for-the-browser-journey-0123456789";
const SECRET_NAME = "GITHUB_EVENT_HUB_SECRET";

let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
let browser: any;

beforeAll(async () => {
  if (!ready) return;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fixture = await launchVerificationServer({ ...process.env }, undefined, undefined, undefined, undefined, { scripted: true }, [], undefined, dist);
  const { chromium } = createRequire(join(playwrightPath!, "package.json"))("playwright-core");
  // A mock keychain keeps the test browser from asking the person's macOS keychain for anything.
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--use-mock-keychain"] });
  mkdirSync(shots, { recursive: true });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await fixture?.close();
  vi.restoreAllMocks();
});

it.skipIf(!ready)("turns GitHub Event on from the Apps page and shows its first event", async () => {
  const { url, dataDir } = fixture.info;
  const hooks = `http://127.0.0.1:${Number(new URL(url).port) + 1}`;
  const api = async (method: string, path: string, body?: unknown) => (await fetch(`${url}${path}`, {
    method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })).json() as Promise<any>;
  await api("PUT", "/api/config", { onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } });

  const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  const shot = (name: string) => page.screenshot({ path: join(shots, name) });
  const bodies: string[] = [];
  page.on("response", async (response: any) => { if (response.url().includes("/api/pr-orchestrator/")) bodies.push(await response.text().catch(() => "")); });
  await page.goto(url);
  const skipTour = page.getByRole("button", { name: "Skip tour" });
  if (await skipTour.isVisible({ timeout: 15_000 }).catch(() => false)) await skipTour.click();
  await page.locator('[data-tour="nav-apps"]').first().click();

  // 1. A fresh install lists both event apps, off, apart from the tool apps.
  const section = page.locator('[data-apps-section="apps-section-event-sources"]');
  await section.waitFor({ timeout: 30_000 });
  const github = section.locator('[data-event-source-tile="github-event"]');
  expect(await section.locator("[data-event-source-tile]").count()).toBe(2);
  expect(await github.getAttribute("data-event-source-state")).toBe("off");
  await shot("event-sources-off.png");

  // 2. The tile switch opens the gate; with no key in the Vault the tile asks for setup.
  await github.getByRole("switch").click();
  await expect.poll(() => github.getAttribute("data-event-source-state"), { timeout: 15_000 }).toBe("needs_setup");
  expect(JSON.parse(readFileSync(join(dataDir, "pr-orchestrator.json"), "utf8")).connectors["github-event"].enabled).toBe(true);
  await github.getByRole("button", { expanded: false }).click();
  const detail = section.locator('[data-event-source-detail="github-event"]');
  expect(await detail.locator("[data-secret-state]").textContent()).toBe("Not saved");
  await shot("event-sources-needs-setup.png");

  // 3. The key is saved in the Vault; the detail shows Saved and never the value.
  expect((await api("POST", "/api/vault/secrets", { name: SECRET_NAME, value: HUB_KEY }))).toBeTruthy();
  await github.getByRole("button", { expanded: true }).click();
  await github.getByRole("button", { expanded: false }).click();
  await expect.poll(() => detail.locator("[data-secret-state]").textContent(), { timeout: 15_000 }).toBe("Saved");
  expect(await page.content()).not.toContain(HUB_KEY);

  // 4. A signed batch arrives; the detail shows the first event.
  const event = structuredClone(validFixtures().find(item => item.type === "pr.opened")!.event);
  const body = JSON.stringify({ v: 1, events: [event] });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sent = await fetch(`${hooks}/events/github-event`, {
    method: "POST", body, headers: { "content-type": "application/json", "x-omb-timestamp": timestamp, "x-omb-signature": signBatch(Buffer.from(HUB_KEY), timestamp, Buffer.from(body)) },
  });
  expect(sent.status).toBe(200);
  await github.getByRole("button", { expanded: true }).click();
  await github.getByRole("button", { expanded: false }).click();
  await expect.poll(() => github.getAttribute("data-event-source-state"), { timeout: 15_000 }).toBe("receiving");
  expect(await detail.textContent()).not.toContain("Last eventNone");
  expect(bodies.filter(text => text.includes(HUB_KEY))).toEqual([]);
  await shot("event-sources-receiving.png");
});
