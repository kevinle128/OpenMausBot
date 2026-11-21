// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(), copy: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api }));
vi.mock("@/lib/copy-text", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/copy-text")>(), copyText: fixture.copy }));
const { VaultSkillDialog } = await import("./VaultSkillDialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

const row = (harness: string, label: string, status: string, extra: Record<string, unknown> = {}) => ({ harness, label, folder: `/home/me/${harness}`, status, recognised: true, ...extra });
const ROWS = [
  row("claudeAgent", "Claude", "installed"),
  row("codex", "Codex", "outdated"),
  row("geminiAgent", "Gemini", "missing", { recognised: false }),
  row("deepseekAgent", "DeepSeek Harness", "unsupported", { folder: null, note: "DeepSeek documents no literal skill folder" }),
];

beforeEach(() => {
  fixture.api.mockReset();
  fixture.copy.mockReset().mockResolvedValue("copied");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { ogb?: unknown }).ogb;
});

const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
async function render() {
  await act(async () => root.render(createElement(VaultSkillDialog, { onClose: () => {} })));
  await tick();
}
const box = (name: string) => document.body.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const button = (label: string) => [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;
async function check(name: string) { await act(async () => box(name).click()); }
const rowOf = (id: string) => document.body.querySelector(`[data-skill-row="${id}"]`)!;

describe("Settings → Vault: install the skill, on this computer from the desktop app", () => {
  const desktop = (install: ReturnType<typeof vi.fn>) => {
    (window as { ogb?: unknown }).ogb = { ombSkill: { state: vi.fn().mockResolvedValue({ available: true, paired: false, rows: ROWS }), install } };
  };

  it("lists every harness with its state and its folder, notes the ones omb cannot name yet and disables an unsupported one with its reason", async () => {
    desktop(vi.fn());
    await render();
    expect([...document.body.querySelectorAll("[data-skill-row]")].map((item) => item.getAttribute("data-skill-row"))).toEqual(["claudeAgent", "codex", "geminiAgent", "deepseekAgent"]);
    expect(rowOf("claudeAgent").textContent).toContain("Installed");
    expect(rowOf("claudeAgent").textContent).toContain("/home/me/claudeAgent");
    expect(rowOf("codex").textContent).toContain("Outdated");
    expect(rowOf("geminiAgent").textContent).toContain("cannot name this agent yet");
    expect(box("deepseekAgent").disabled).toBe(true);
    expect(rowOf("deepseekAgent").textContent).toContain("DeepSeek documents no literal skill folder");
    expect(document.body.querySelector("[data-skill-where]")?.getAttribute("data-skill-where")).toBe("computer");
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("selects every supported row with Select all, and installs for the chosen ones only after it asks this computer for a pairing code", async () => {
    const install = vi.fn()
      .mockResolvedValueOnce({ needsPairing: true, rows: [] })
      .mockResolvedValueOnce({ rows: [row("codex", "Codex", "updated"), row("geminiAgent", "Gemini", "installed", { note: "left a note" })] });
    desktop(install);
    fixture.api.mockResolvedValueOnce({ code: "ABCD-EFGH-JKLM", url: null });
    await render();
    expect(button("Install").disabled).toBe(true);
    await check("selectAll");
    expect(box("claudeAgent").checked && box("codex").checked && box("geminiAgent").checked).toBe(true);
    expect(box("deepseekAgent").checked).toBe(false);
    await check("claudeAgent");
    await act(async () => button("Install").click());
    await tick();
    expect(fixture.api).toHaveBeenCalledWith("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["secrets"] }) });
    expect(install).toHaveBeenNthCalledWith(1, ["codex", "geminiAgent"]);
    expect(install).toHaveBeenNthCalledWith(2, ["codex", "geminiAgent"], "ABCD-EFGH-JKLM");
    expect(rowOf("codex").textContent).toContain("Updated");
    expect(rowOf("geminiAgent").textContent).toContain("Installed");
    expect(rowOf("geminiAgent").textContent).toContain("left a note");
    expect(document.body.textContent).not.toContain("ABCD-EFGH-JKLM");
  });

  it("asks for no pairing code when this computer is already paired, and a second click updates in place", async () => {
    const install = vi.fn().mockResolvedValue({ rows: [row("codex", "Codex", "unchanged")] });
    desktop(install);
    await render();
    await check("codex");
    await act(async () => button("Install").click());
    await tick();
    await act(async () => button("Install").click());
    await tick();
    expect(install).toHaveBeenCalledTimes(2);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(rowOf("codex").textContent).toContain("Already up to date");
  });

  it("shows the reason when the install fails, and a pairing that stays", async () => {
    desktop(vi.fn().mockResolvedValue({ rows: [], error: "the server refused the code", notes: [{ key: "pairedElsewhere", server: "https://other.example.com" }] }));
    await render();
    await check("codex");
    await act(async () => button("Install").click());
    await tick();
    expect(document.body.querySelector("[role=alert]")?.textContent).toBe("the server refused the code");
    expect(document.body.textContent).toContain("already paired with https://other.example.com");
  });
});

describe("Settings → Vault: install the skill from a browser", () => {
  it("installs on the server's computer through the admin route, and offers the commands for other computers", async () => {
    fixture.api.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === "/api/secrets/admin/skill-install" && !init) return { data: { rows: ROWS } };
      if (path === "/api/secrets/admin/skill-install") return { data: { rows: [row("codex", "Codex", "updated")], command: "/home/me/.local/bin/omb" } };
      return { code: "ABCD-EFGH-JKLM", url: "https://maus.example.com/pair#code=ABCD-EFGH-JKLM" };
    });
    await render();
    expect(document.body.querySelector("[data-skill-where]")?.getAttribute("data-skill-where")).toBe("server");
    await check("codex");
    await act(async () => button("Install").click());
    await tick();
    expect(fixture.api).toHaveBeenCalledWith("/api/secrets/admin/skill-install", { method: "POST", body: JSON.stringify({ harnesses: ["codex"] }) });
    expect(rowOf("codex").textContent).toContain("Updated");
    expect(document.body.querySelector("[data-skill-command=install]")?.textContent).toBe("omb skill install --harness codex");
    expect(document.body.querySelector("[data-skill-command=pair]")).toBeNull();
    await act(async () => button("Make a pairing link").click());
    await tick();
    expect(fixture.api).toHaveBeenCalledWith("/api/auth/pairing", { method: "POST", body: JSON.stringify({ scopes: ["secrets"] }) });
    expect(document.body.querySelector("[data-skill-command=pair]")?.textContent).toBe("omb pair 'https://maus.example.com/pair#code=ABCD-EFGH-JKLM'");
    await act(async () => button("Copy").click());
    expect(fixture.copy).toHaveBeenCalledWith("omb pair 'https://maus.example.com/pair#code=ABCD-EFGH-JKLM'");
  });

  it("keeps the outcome of an earlier install when a second one covers other rows, and says the server's computer is not paired", async () => {
    fixture.api.mockImplementation(async (_path: string, init?: { method?: string; body?: string }) => {
      if (!init) return { data: { rows: ROWS } };
      const [harness] = JSON.parse(init.body ?? "{}").harnesses as string[];
      return { data: { rows: [row(harness, harness, "updated")], command: "/home/me/.local/bin/omb", notes: [{ key: "serverNotPaired" }] } };
    });
    await render();
    await check("codex");
    await act(async () => button("Install").click());
    await tick();
    await check("codex");
    await check("geminiAgent");
    await act(async () => button("Install").click());
    await tick();
    expect(rowOf("codex").textContent).toContain("Updated");
    expect(rowOf("geminiAgent").textContent).toContain("Updated");
    expect(document.body.querySelector("[data-skill-server-not-paired]")?.textContent).toContain("not paired with the Vault yet");
  });

  it("puts the code and --server in the pair command when the server has no link another computer can open", async () => {
    fixture.api.mockImplementation(async (path: string) => (path === "/api/auth/pairing" ? { code: "ABCD-EFGH-JKLM", url: null } : { data: { rows: ROWS } }));
    await render();
    await act(async () => button("Make a pairing link").click());
    await tick();
    expect(document.body.querySelector("[data-skill-command=pair]")?.textContent).toBe("omb pair ABCD-EFGH-JKLM --server SERVER_URL");
    expect(document.body.querySelector("[data-skill-no-link]")).toBeTruthy();
    expect(document.body.textContent).not.toContain(`${location.origin}/pair`);
  });

  it("installs on this computer while connected to another server, asks for no pairing code, and shows the next step", async () => {
    const install = vi.fn().mockResolvedValue({ rows: [row("codex", "Codex", "installed")], notes: [{ key: "pairNeeded", server: "https://mini.example.com" }] });
    (window as { ogb?: unknown }).ogb = { remoteClient: { active: true }, ombSkill: { state: vi.fn().mockResolvedValue({ available: true, paired: false, rows: ROWS }), install } };
    await render();
    await check("codex");
    await act(async () => button("Install").click());
    await tick();
    expect(install).toHaveBeenCalledWith(["codex"]);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(rowOf("codex").textContent).toContain("Installed");
    expect(document.body.querySelector("[data-skill-pair-needed]")?.textContent).toContain("--server https://mini.example.com < FILE");
    expect(document.body.querySelector("[data-skill-pair-needed]")?.textContent).toContain("omb pair --token-stdin --server https://mini.example.com");
  });

  it("never falls back to the server route when the app's bridge is there, also on another server's page and where the app cannot install", async () => {
    const install = vi.fn().mockResolvedValue({ rows: [row("codex", "Codex", "installed")], notes: [{ key: "pairNeeded", server: "https://mini.example.com" }] });
    (window as { ogb?: unknown }).ogb = { ombSkill: { state: vi.fn().mockResolvedValue({ available: true, paired: false, rows: ROWS }), install } };
    await render();
    await check("codex");
    await act(async () => button("Install").click());
    await tick();
    expect(install).toHaveBeenCalledWith(["codex"]);
    expect(fixture.api).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(host);
    (window as { ogb?: unknown }).ogb = { ombSkill: { state: vi.fn().mockResolvedValue({ available: false, paired: false, rows: [] }), install: vi.fn() } };
    await render();
    expect(document.body.querySelector("[data-skill-unavailable]")).not.toBeNull();
    expect(fixture.api).not.toHaveBeenCalled();
  });

  it("says why when the folders cannot be read", async () => {
    fixture.api.mockRejectedValueOnce(new Error("this server does not carry the omb command"));
    await render();
    expect(document.body.querySelector("[role=alert]")?.textContent).toBe("this server does not carry the omb command");
  });
});
