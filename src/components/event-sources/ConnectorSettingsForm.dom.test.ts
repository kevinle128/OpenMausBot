// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConnectorSettingsForm } from "./ConnectorSettingsForm";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const setValue = async (field: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label) as HTMLButtonElement;

it("builds a number field with its limits and saves it", async () => {
  const onSave = vi.fn(async () => {});
  const schema = { type: "object", properties: { toleranceSeconds: { type: "integer", minimum: 30, maximum: 900, default: 300 } } };
  await act(async () => root.render(createElement(ConnectorSettingsForm, { schema, settings: { toleranceSeconds: 300 }, onSave })));
  const field = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect([field.min, field.max, field.value]).toEqual(["30", "900", "300"]);
  expect(button("Save").disabled).toBe(true);
  await setValue(field, "10");
  expect(button("Save").disabled).toBe(true);
  await setValue(field, "120");
  expect(button("Save").disabled).toBe(false);
  await act(async () => button("Save").click());
  expect(onSave).toHaveBeenCalledWith({ toleranceSeconds: 120 });
});

it("shows the server's message when a save is refused", async () => {
  const onSave = vi.fn(async () => { throw new Error("toleranceSeconds must be at least 30"); });
  const schema = { type: "object", properties: { toleranceSeconds: { type: "integer", minimum: 30, maximum: 900 } } };
  await act(async () => root.render(createElement(ConnectorSettingsForm, { schema, settings: { toleranceSeconds: 300 }, onSave })));
  await setValue(container.querySelector<HTMLInputElement>('input[type="number"]')!, "200");
  await act(async () => button("Save").click());
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("toleranceSeconds must be at least 30");
});

it("shows an unsupported settings shape read-only", async () => {
  const onSave = vi.fn(async () => {});
  const schema = { type: "object", properties: { repos: { type: "array", items: { type: "string" } } } };
  await act(async () => root.render(createElement(ConnectorSettingsForm, { schema, settings: { repos: ["a/b"] }, onSave })));
  const readOnly = container.querySelector('[data-settings-readonly="repos"]')!;
  expect(readOnly.querySelector("pre")!.textContent).toContain('"a/b"');
  expect(readOnly.textContent).toContain("Edit in the config file");
  expect(container.querySelector("input")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
});
