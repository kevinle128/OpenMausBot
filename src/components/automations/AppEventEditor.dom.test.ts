// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AppTrigger } from "@/lib/app-triggers";
import type { Bot } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  api: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: (...args: unknown[]) => fixture.api(...args),
}));

const { AppEventEditor } = await import("./AppEventEditor");

const scout = { id: "bot-a", name: "Scout", threadId: "thread-a", hidden: false, messages: [] } as unknown as Bot;
const now = Date.now();
const pull = (options: string[]) => ({
  event: "pull_request", name: "Pull request activity", description: "", delivery: "instant",
  configFields: [
    { name: "types", type: "string", required: true, options },
    { name: "repos", type: "string", required: true },
    { name: "authors", type: "string", required: false },
  ],
  filterFields: [],
});
const catalog = {
  apps: [
    { app: "gmail", name: "Gmail", accounts: [{ id: "ca_1" }], events: [{ event: "GMAIL_NEW_GMAIL_MESSAGE", name: "New Gmail message", description: "", delivery: "poll", configFields: [], filterFields: [] }] },
    { app: "slack", name: "Slack", accounts: [{ id: "sl_1" }], events: [{ event: "SLACK_RECEIVE_MESSAGE", name: "New message in channel", description: "", delivery: "instant", configFields: [{ name: "channel", type: "string", required: true, description: "e.g. #sales" }], filterFields: [] }] },
    { app: "github-event", name: "GitHub Event", accounts: [{ id: "github-event" }], events: [pull(["pr.ci.finished", "pr.review.finished", "pr.opened"])] },
    { app: "gitlab-event", name: "GitLab Event", accounts: [{ id: "gitlab-event" }], events: [pull(["pr.ci.finished", "pr.opened"])] },
  ],
  notConnected: [],
};
const saved: AppTrigger = {
  id: "merge-valid", name: "Merge valid PRs", prompt: "Read the pull request.", botId: "bot-a", runOn: "maus", enabled: true,
  app: "github-event", appName: "GitHub Event", event: "pull_request", eventName: "Pull request activity", delivery: "instant",
  accountId: "github-event", config: { types: ["pr.opened"], repos: ["acme/widgets"], authors: [] },
  remote: { state: "active" }, received: 0, filtered: 0, createdAt: now, updatedAt: now,
};

let root: Root | null = null;
function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(element));
  return container;
}
const button = (container: HTMLElement, label: string) => [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement;
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const choose = (container: HTMLElement, label: string, value: string) => {
  const field = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(field, value);
  flushSync(() => field.dispatchEvent(new Event("change", { bubbles: true })));
};

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: unknown) => {
    const p = String(path);
    if (p.startsWith("/api/app-triggers/events")) return catalog;
    if (p.startsWith("/api/apps/")) return { items: [] };
    return { trigger: saved };
  });
  fixture.state = { bots: [scout] };
});
afterEach(() => { root?.unmount(); root = null; document.body.innerHTML = ""; });

it("choosing GitHub Event shows type checkboxes and a repos field and sends them as config", async () => {
  const onSaved = vi.fn();
  const container = mount(createElement(AppEventEditor, { bots: [scout], onClose: vi.fn(), onSaved }));
  await vi.waitFor(() => expect(container.querySelector('select[aria-label="App"]')).not.toBeNull());
  expect(container.textContent).toContain("From · optional");
  expect(container.textContent).not.toContain("Event types");
  choose(container, "App", "slack");
  expect(container.querySelector('input[placeholder="e.g. #sales"]')).not.toBeNull();
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  choose(container, "App", "gitlab-event");
  expect(container.textContent).toContain("For example vtc/blr/blr-game-serv or vtc/blr/*");
  choose(container, "App", "github-event");
  expect([...container.querySelectorAll('input[type="checkbox"]')].map((box) => box.getAttribute("value"))).toEqual(["pr.ci.finished", "pr.review.finished", "pr.opened"]);
  expect(container.textContent).toContain("CI finished");
  expect(container.textContent).toContain("Review finished");
  const addRepoTag = (container: HTMLElement, value: string) => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Repos"]')!;
    type(input, value);
    flushSync(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  };
  expect(container.querySelector('input[aria-label="Repos"]')).not.toBeNull();
  expect(container.textContent).toContain("For example kevinle128/OpenMausBot or kevinle128/*");
  const sample = [...container.querySelectorAll("textarea")].find((field) => field.getAttribute("placeholder")?.startsWith("Read `pr`"))!;
  expect(sample.getAttribute("placeholder")).toContain("--match-head-commit");
  expect(sample.getAttribute("placeholder")).toContain("--sha");
  expect(sample.getAttribute("placeholder")).toContain("--auto-merge=false");
  expect(sample.getAttribute("placeholder")).toContain("glab mr merge <pr.number> -R <pr.repo> --sha <pr.headSha> --auto-merge=false --squash --yes");
  expect(button(container, "Set it up").disabled).toBe(true);
  flushSync(() => container.querySelector<HTMLInputElement>('input[value="pr.ci.finished"]')!.click());
  flushSync(() => container.querySelector<HTMLInputElement>('input[value="pr.review.finished"]')!.click());
  addRepoTag(container, "kevinle128/OpenMausBot");
  addRepoTag(container, "kevinle128/*");
  type(container.querySelector('input[placeholder="e.g. kevinle128"]')!, "kevinle128");
  type(sample, "Read the pull request and merge it when it is valid.");
  flushSync(() => button(container, "Set it up").click());
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  const [, init] = fixture.api.mock.calls.find(([path]) => path === "/api/app-triggers") as [string, RequestInit];
  expect(JSON.parse(String(init.body))).toMatchObject({
    botId: "bot-a", app: "github-event", event: "pull_request",
    prompt: "Read the pull request and merge it when it is valid.",
    config: { types: ["pr.ci.finished", "pr.review.finished"], repos: "kevinle128/OpenMausBot\nkevinle128/*", authors: "kevinle128" },
  });
});

it("a repos entry of only commas keeps Set it up disabled", async () => {
  const container = mount(createElement(AppEventEditor, { bots: [scout], onClose: vi.fn() }));
  await vi.waitFor(() => expect(container.querySelector('select[aria-label="App"]')).not.toBeNull());
  choose(container, "App", "github-event");
  flushSync(() => container.querySelector<HTMLInputElement>('input[value="pr.ci.finished"]')!.click());
  const repoInput = container.querySelector<HTMLInputElement>('input[aria-label="Repos"]')!;
  type(repoInput, ",");
  flushSync(() => { repoInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(button(container, "Set it up").disabled).toBe(true);
  type(repoInput, "acme/widgets");
  flushSync(() => { repoInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(button(container, "Set it up").disabled).toBe(false);
});

it("editing an event-app automation sends its changed types", async () => {
  const onSaved = vi.fn();
  const container = mount(createElement(AppEventEditor, { trigger: saved, bots: [scout], onClose: vi.fn(), onSaved }));
  expect(container.querySelector<HTMLInputElement>('input[value="pr.opened"]')!.checked).toBe(true);
  expect(container.querySelector('[data-resource-tag="acme/widgets"]')).not.toBeNull();
  flushSync(() => container.querySelector<HTMLInputElement>('input[value="pr.opened"]')!.click());
  flushSync(() => container.querySelector<HTMLInputElement>('input[value="pr.ci.finished"]')!.click());
  flushSync(() => button(container, "Save").click());
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  const [, init] = fixture.api.mock.calls.find(([path]) => path === "/api/app-triggers/merge-valid") as [string, RequestInit];
  expect(init.method).toBe("PATCH");
  expect(JSON.parse(String(init.body)).config.types).toEqual(["pr.ci.finished"]);
  expect(JSON.parse(String(init.body)).config.repos).toBe("acme/widgets");
});

it("editing keeps stored filter fields the modal does not show", async () => {
  const onSaved = vi.fn();
  const slack: AppTrigger = { ...saved, id: "slack-orders", app: "slack", appName: "Slack", event: "SLACK_RECEIVE_MESSAGE", config: {}, filter: { from: "ada", text: "urgent" } };
  const container = mount(createElement(AppEventEditor, { trigger: slack, bots: [scout], onClose: vi.fn(), onSaved }));
  flushSync(() => button(container, "Save").click());
  await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  const [, init] = fixture.api.mock.calls.find(([path]) => path === "/api/app-triggers/slack-orders") as [string, RequestInit];
  expect(JSON.parse(String(init.body)).filter).toEqual({ from: "ada", text: "urgent" });
});
