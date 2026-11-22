// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectorFixture } from "./fixtures";

const fixture = vi.hoisted(() => ({
  connectors: [] as any[],
  puts: [] as Array<{ path: string; body: any }>,
  dispatched: [] as any[],
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: {}, dispatch: (action: unknown) => fixture.dispatched.push(action) }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body!);
      fixture.puts.push({ path, body });
      const id = decodeURIComponent(path.split("/").pop()!);
      const next = { ...fixture.connectors.find((item) => item.id === id), ...body };
      fixture.connectors = fixture.connectors.map((item) => (item.id === id ? next : item));
      return next;
    }
    return { connectors: fixture.connectors };
  },
}));
import { EventSourcesSection } from "./EventSourcesSection";

const SECRET_VALUE = "super-secret-hub-key-value";
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.puts = [];
  fixture.dispatched = [];
  fixture.connectors = [connectorFixture(), connectorFixture({ id: "gitlab-event", title: "GitLab Event", icon: { glyph: "gitlab" }, intakePath: "/events/gitlab-event", intakeUrl: null, secretName: "GITLAB_EVENT_HUB_SECRET" })];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function show() {
  await act(async () => root.render(createElement(EventSourcesSection)));
  await act(async () => {});
}
const tile = (id: string) => container.querySelector(`[data-event-source-tile="${id}"]`) as HTMLElement;

it("lists GitHub Event and GitLab Event apart from the tool apps", async () => {
  await show();
  const section = container.querySelector('[data-apps-section="apps-section-event-sources"]')!;
  expect(section.querySelector("h3")!.textContent).toContain("Event sources");
  expect([...section.querySelectorAll("[data-event-source-tile]")].map((node) => node.getAttribute("data-event-source-tile"))).toEqual(["github-event", "gitlab-event"]);
  expect(container.querySelector("[data-app-tile]")).toBeNull();
  expect(tile("github-event").getAttribute("data-event-source-state")).toBe("off");
  expect(tile("github-event").textContent).toContain("Sends events");
});

it("turns a connector on from its tile and shows needs setup until its secret is saved", async () => {
  await show();
  await act(async () => (tile("github-event").querySelector('[role="switch"]') as HTMLButtonElement).click());
  expect(fixture.puts).toEqual([{ path: "/api/pr-orchestrator/connectors/github-event", body: { enabled: true } }]);
  expect(tile("github-event").getAttribute("data-event-source-state")).toBe("needs_setup");
});

it("shows a connector that only the test registered, with its event types and settings form", async () => {
  fixture.connectors = [connectorFixture({
    id: "test-feed", title: "Test Feed", icon: { glyph: "unknown-glyph" }, intakePath: null, intakeUrl: null, secretName: null, enabled: true,
    settings: { mode: "fast", limit: 5 },
    settingsSchema: { type: "object", properties: { mode: { type: "string", enum: ["fast", "slow"] }, limit: { type: "integer", minimum: 1, maximum: 10 } } },
    eventTypes: [{ type: "feed.item", title: "Feed item", description: "A new item.", payloadSchema: { type: "object", title: "<img src=x onerror=alert(1)>" } }],
    usedBy: [],
  })];
  await show();
  expect(tile("test-feed").textContent).toContain("Test Feed");
  expect(tile("test-feed").textContent).toContain("T");
  await act(async () => (tile("test-feed").querySelector("button[aria-expanded]") as HTMLButtonElement).click());
  const detail = container.querySelector('[data-event-source-detail="test-feed"]')!;
  expect(detail.querySelector('[data-event-type="feed.item"]')!.textContent).toContain("Feed item");
  expect(detail.querySelector("select")!.value).toBe("fast");
  expect(detail.querySelector<HTMLInputElement>('input[type="number"]')!.max).toBe("10");
  // The payload schema is plain text: nothing in it becomes an element.
  expect(detail.querySelector("img")).toBeNull();
  expect(detail.querySelector("pre")!.textContent).toContain("<img src=x");
});

it("never shows a secret value, only whether it is saved", async () => {
  fixture.connectors = [connectorFixture({ enabled: true, secretPresent: true, intakeUrl: null })];
  await show();
  await act(async () => (tile("github-event").querySelector("button[aria-expanded]") as HTMLButtonElement).click());
  const detail = container.querySelector('[data-event-source-detail="github-event"]')!;
  expect(detail.querySelector("[data-secret-state]")!.textContent).toBe("Saved");
  expect(detail.textContent).toContain("GITHUB_EVENT_HUB_SECRET");
  expect(container.innerHTML).not.toContain(SECRET_VALUE);
  expect(container.querySelector('input[type="password"]')).toBeNull();
  // The hub sink names the environment variable, never a key.
  expect(detail.textContent).toContain("secretEnv: GITHUB_EVENT_HUB_SECRET");
});

it("opens the Vault place from the detail", async () => {
  await show();
  await act(async () => (tile("github-event").querySelector("button[aria-expanded]") as HTMLButtonElement).click());
  const open = [...container.querySelectorAll("button")].find((button) => button.textContent === "Open Vault")!;
  await act(async () => open.click());
  expect(fixture.dispatched).toContainEqual({ type: "toggleAppSettings", open: true, section: "vault" });
});

it("renders nothing when the list is empty", async () => {
  fixture.connectors = [];
  await show();
  expect(container.innerHTML).toBe("");
});
