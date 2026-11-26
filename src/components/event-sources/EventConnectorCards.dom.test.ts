// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ForgeApp } from "@/lib/forge-apps";

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

const GH: ForgeApp = {
  id: "github", title: "GitHub", description: "Pull requests, repositories, and automated workflows.",
  baseUrl: "https://api.github.com", connected: false, login: null,
};
const GL: ForgeApp = {
  id: "gitlab", title: "GitLab", description: "Self-hosted GitLab projects, merge requests, and CI events.",
  baseUrl: "https://git.oceanlabs.dev", connected: false, login: null,
};

describe("Unified Forge App cards (GitHub & self-hosted GitLab)", () => {
  it("shows in All and Developer tools, hides in other categories, and filters by Connected and search", async () => {
    apiMock.mockResolvedValue({ apps: [{ ...GH, connected: true, login: "kevinle128" }, GL] });

    const onCount = vi.fn();
    const el = await renderCards({ filter: "all", category: "Developer tools", search: "", onCount });
    expect(el.querySelectorAll("[data-event-source-tile]").length).toBe(2);
    expect(onCount).toHaveBeenLastCalledWith(1, 2);
    expect(el.textContent).toContain("@kevinle128");
    expect(el.textContent).toContain("Required PAT scopes");

    await act(async () => { root!.render(createElement(EventConnectorCards, { filter: "all", category: "Social", search: "", onCount })); });
    expect(el.querySelectorAll("[data-event-source-tile]").length).toBe(0);

    await act(async () => { root!.render(createElement(EventConnectorCards, { filter: "connected", category: null, search: "", onCount })); });
    expect(el.querySelectorAll("[data-event-source-tile]").length).toBe(1);
    expect(el.querySelector("[data-event-source-tile='github']")).not.toBeNull();

    await act(async () => { root!.render(createElement(EventConnectorCards, { filter: "all", category: null, search: "gitlab", onCount })); });
    expect(el.querySelectorAll("[data-event-source-tile]").length).toBe(1);
    expect(el.querySelector("[data-event-source-tile='gitlab']")).not.toBeNull();
  });

  it("connects GitLab with server URL + PAT and disconnects via DELETE", async () => {
    apiMock
      .mockResolvedValueOnce({ apps: [GL] })
      .mockResolvedValueOnce({ ...GL, connected: true, login: "kevin.le", baseUrl: "https://git.example.com" })
      .mockResolvedValueOnce({ ...GL, connected: false, login: null });

    const el = await renderCards({ filter: "all", category: null, search: "" });
    const urlInput = el.querySelector<HTMLInputElement>("input[type='url']")!;
    const tokenInput = el.querySelector<HTMLInputElement>("input[type='password']")!;
    const setVal = (input: HTMLInputElement, val: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };

    await act(async () => {
      setVal(urlInput, "https://git.example.com");
      setVal(tokenInput, "glpat-secret-123");
    });

    const connectBtn = el.querySelector<HTMLButtonElement>("button[aria-label*='Connect']")!;
    expect(connectBtn.disabled).toBe(false);
    await act(async () => { connectBtn.click(); });

    expect(apiMock).toHaveBeenCalledWith("/api/apps/forge/gitlab", {
      method: "PUT",
      body: JSON.stringify({ token: "glpat-secret-123", baseUrl: "https://git.example.com" }),
    });
    expect(el.querySelector("input[type='password']")).toBeNull();

    const disconnectBtn = el.querySelector<HTMLButtonElement>("button[aria-label*='Disconnect']")!;
    await act(async () => { disconnectBtn.click(); });
    expect(apiMock).toHaveBeenCalledWith("/api/apps/forge/gitlab", { method: "DELETE" });
  });
});
