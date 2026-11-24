// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EventConnector } from "@/lib/event-connectors";
import { connectorFixture } from "./fixtures";

const apiMock = vi.fn();

vi.mock("@/state/store", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

import { EventConnectorCards } from "./EventConnectorCards";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
  apiMock.mockReset();
});

async function renderCards(props: Parameters<typeof EventConnectorCards>[0]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(EventConnectorCards, props)); });
  await act(async () => { await Promise.resolve(); });
  return host;
}

describe("EventConnectorCards", () => {
  it("shows in All and Developer tools, hides in other categories, and filters by Connected and search", async () => {
    const gh = connectorFixture({ id: "github-event", title: "GitHub Event", enabled: true, secretPresent: true });
    const gl = connectorFixture({ id: "gitlab-event", title: "GitLab Event", enabled: false, secretPresent: false });
    apiMock.mockResolvedValue({ connectors: [gh, gl] });

    const onCount = vi.fn();
    const el = await renderCards({ filter: "all", category: "Developer tools", search: "", onCount });
    expect(el.querySelectorAll("[data-event-source-tile]").length).toBe(2);
    expect(onCount).toHaveBeenLastCalledWith(1, 2);

    await act(async () => { root!.render(createElement(EventConnectorCards, { filter: "all", category: "Social", search: "", onCount })); });
    expect(el.querySelectorAll("[data-event-source-tile]").length).toBe(0);

    await act(async () => { root!.render(createElement(EventConnectorCards, { filter: "connected", category: null, search: "", onCount })); });
    expect(el.querySelectorAll("[data-event-source-tile]").length).toBe(1);
    expect(el.querySelector("[data-event-source-tile='github-event']")).not.toBeNull();

    await act(async () => { root!.render(createElement(EventConnectorCards, { filter: "all", category: null, search: "gitlab", onCount })); });
    expect(el.querySelectorAll("[data-event-source-tile]").length).toBe(1);
    expect(el.querySelector("[data-event-source-tile='gitlab-event']")).not.toBeNull();
  });

  it("connects with a pasted key and disconnects by clearing it, without Vault or setup chrome", async () => {
    const gh: EventConnector = connectorFixture({ id: "github-event", title: "GitHub Event", enabled: false, secretPresent: false });
    apiMock
      .mockResolvedValueOnce({ connectors: [gh] })
      .mockResolvedValueOnce({ ...gh, enabled: true, secretPresent: true })
      .mockResolvedValueOnce({ ...gh, enabled: false, secretPresent: false });

    const el = await renderCards({ filter: "all", category: null, search: "" });
    expect(el.textContent).not.toContain("Vault");
    expect(el.textContent).not.toContain("Address that receives events");

    const connectBtn = el.querySelector<HTMLButtonElement>("button")!;
    expect(connectBtn.disabled).toBe(true);

    const input = el.querySelector<HTMLInputElement>("input[type='password']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "my-hub-secret");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(connectBtn.disabled).toBe(false);

    await act(async () => { connectBtn.click(); });
    expect(apiMock).toHaveBeenCalledWith("/api/pr-orchestrator/connectors/github-event", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, secret: "my-hub-secret" }),
    });
    expect(el.querySelector("input[type='password']")).toBeNull();

    const disconnectBtn = el.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { disconnectBtn.click(); });
    expect(apiMock).toHaveBeenCalledWith("/api/pr-orchestrator/connectors/github-event", {
      method: "PUT",
      body: JSON.stringify({ enabled: false, secret: "" }),
    });
  });
});
