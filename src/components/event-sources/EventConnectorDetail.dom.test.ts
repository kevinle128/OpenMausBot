// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AppTrigger } from "@/lib/app-triggers";
import type { Bot } from "@/state/store";
import { connectorFixture } from "./fixtures";

const fixture = vi.hoisted(() => ({
  bots: [] as Bot[],
  triggers: [] as AppTrigger[],
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { bots: fixture.bots }, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { EventConnectorDetail } = await import("./EventConnectorDetail");
const { applyAppTriggerSnapshot } = await import("@/lib/app-triggers");

const now = Date.now();
const bot = (id: string, name: string) => ({ id, name, threadId: id, hidden: false, messages: [] }) as unknown as Bot;
const routine = (over: Partial<AppTrigger>): AppTrigger => ({
  id: "merge-valid", name: "Merge valid PRs", prompt: "Read the pull request.", botId: "merge", runOn: "maus", enabled: true,
  app: "github-event", appName: "GitHub Event", event: "pull_request", eventName: "Pull request activity", delivery: "instant",
  accountId: "github-event", config: { types: ["pr.ci.finished"], repos: ["acme/widgets"] },
  remote: { state: "active" }, received: 0, filtered: 0, createdAt: now, updatedAt: now, ...over,
});
const sourceApp = (app: string, name: string) => ({
  app, name, accounts: [{ id: app }],
  events: [{ event: "pull_request", name: "Pull request activity", description: "", delivery: "instant", configFields: [{ name: "types", type: "string", required: true, options: ["pr.ci.finished"] }, { name: "repos", type: "string", required: true }], filterFields: [] }],
});
const githubCatalog = { apps: [sourceApp("github-event", "GitHub Event"), sourceApp("gitlab-event", "GitLab Event")], notConnected: [] };

let root: Root | null = null;
function show(id = "github-event", enabled = true) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(EventConnectorDetail, {
    connector: connectorFixture({ id, enabled, title: id === "gitlab-event" ? "GitLab Event" : "GitHub Event" }),
    busy: false, error: null, onSave: vi.fn(async () => {}), onOpenVault: vi.fn(),
  })));
  return container;
}
const addButton = (container: HTMLElement) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Add a bot routine"))!;

beforeEach(() => {
  fixture.bots = [bot("merge", "Merge Bot"), bot("scout", "Scout")];
  fixture.triggers = [];
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: unknown) => {
    if (String(path).startsWith("/api/app-triggers/events")) return githubCatalog;
    return { triggers: fixture.triggers, attempts: [], service: { available: true } };
  });
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  applyAppTriggerSnapshot({ triggers: [], attempts: [], service: { available: true } });
});

it("Used by lists the bot automations of this event app with their pause state", async () => {
  fixture.triggers = [
    routine({ id: "merge-valid", name: "Merge valid PRs", botId: "merge", enabled: true }),
    routine({ id: "tell-owner", name: "Tell the owner when CI fails", botId: "merge", enabled: false }),
    routine({ id: "other-app", name: "Order emails", app: "gmail", botId: "scout", enabled: true }),
  ];
  applyAppTriggerSnapshot({ triggers: fixture.triggers, attempts: [], service: { available: true } });
  const container = show();
  const row = (id: string) => container.querySelector(`[data-app-trigger="${id}"]`)!;
  expect(row("merge-valid").textContent).toContain("Merge Bot");
  expect(row("merge-valid").textContent).toContain("Merge valid PRs");
  expect(row("merge-valid").textContent).toContain("Active");
  expect(row("tell-owner").textContent).toContain("Paused");
  expect(container.querySelector('[data-app-trigger="other-app"]')).toBeNull();
  expect(container.textContent).not.toContain("When CI fails, run the fix workflow.");
});

it("with none, it offers to add a bot routine", async () => {
  applyAppTriggerSnapshot({ triggers: [], attempts: [], service: { available: true } });
  const container = show("gitlab-event");
  expect(container.textContent).toContain("No bot routine listens to this app yet.");
  expect(container.querySelector("[data-app-trigger]")).toBeNull();
  flushSync(() => addButton(container).click());
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showRoutines", view: "list", newApp: "gitlab-event" });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("with the app off, Add a bot routine stays disabled", () => {
  const container = show("github-event", false);
  const add = addButton(container);
  expect(add.disabled).toBe(true);
  expect(container.textContent).toContain("Turn this app on first.");
  flushSync(() => add.click());
  expect(fixture.dispatch).not.toHaveBeenCalled();
});
