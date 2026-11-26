// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const apiMock = vi.fn();

vi.mock("@/state/store", () => ({
  api: (...args: unknown[]) => apiMock(...args),
}));

import { ResourceTagPicker } from "./ResourceTagPicker";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
  apiMock.mockReset();
});

describe("ResourceTagPicker", () => {
  it("loads project list, selects/removes tags, and adds custom glob on Enter", async () => {
    apiMock.mockResolvedValue({
      items: [
        { id: "kevinle128/*", label: "kevinle128/*", meta: "All in kevinle128", group: "wildcard" },
        { id: "kevinle128/OpenMausBot", label: "kevinle128/OpenMausBot", meta: "Recent", group: "recent" },
        { id: "kevinle128/paseo", label: "kevinle128/paseo", meta: "GitHub", group: "all" },
      ],
    });

    const onChange = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(createElement(ResourceTagPicker, {
        app: "github-event",
        values: ["kevinle128/OpenMausBot"],
        onChange,
        placeholder: "Search repos",
        emptyHint: "Type owner/repo",
        ariaLabel: "Repos",
      }));
    });
    await act(async () => { await Promise.resolve(); });

    expect(apiMock).toHaveBeenCalledWith("/api/apps/github-event/resources?kind=repositories");
    expect(host.querySelector("[data-resource-tag='kevinle128/OpenMausBot']")).not.toBeNull();

    const input = host.querySelector<HTMLInputElement>("input")!;
    await act(async () => { input.focus(); });

    // Pick kevinle128/paseo from dropdown
    const options = [...host.querySelectorAll<HTMLButtonElement>("[role='option']")];
    const paseoOpt = options.find((b) => b.textContent?.includes("kevinle128/paseo"))!;
    await act(async () => { paseoOpt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith(["kevinle128/OpenMausBot", "kevinle128/paseo"]);

    // Type custom glob and press Enter
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "acme/*");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(["kevinle128/OpenMausBot", "acme/*"]);

    // Remove existing tag via X button
    const removeBtn = host.querySelector<HTMLButtonElement>("button[aria-label='Remove kevinle128/OpenMausBot']")!;
    await act(async () => { removeBtn.click(); });
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
