import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { updateConnectorInstance } from "./config-writer.ts";
import { parseOrchestratorConfig } from "./config.ts";
import { BUILT_IN_CONNECTORS } from "./connectors/index.ts";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-orchestrator-writer-"));
  path = join(dir, "pr-orchestrator.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = () => JSON.parse(readFileSync(path, "utf8"));

describe("updateConnectorInstance", () => {
  it("turns a connector on without touching the rest of the document", () => {
    const original = { enabled: true, merge: { auto: false }, routines: { useDefaults: false } };
    writeFileSync(path, JSON.stringify(original, null, 2));
    const result = updateConnectorInstance(path, BUILT_IN_CONNECTORS, "github-event", { enabled: true });
    expect(result.ok).toBe(true);
    expect(read()).toEqual({ ...original, connectors: { "github-event": { use: "github-event", enabled: true } } });
    const reloaded = parseOrchestratorConfig(readFileSync(path, "utf8"), BUILT_IN_CONNECTORS);
    expect(reloaded.ok && reloaded.config.connectors["github-event"]?.enabled).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/^\{\n {2}"enabled": true,/);
  });

  it("creates the file when none exists", () => {
    expect(updateConnectorInstance(path, BUILT_IN_CONNECTORS, "gitlab-event", { enabled: true, settings: { toleranceSeconds: 120 } }).ok).toBe(true);
    expect(read().connectors["gitlab-event"]).toEqual({ use: "gitlab-event", enabled: true, settings: { toleranceSeconds: 120 } });
  });

  it("refuses settings that the connector's schema rejects and leaves the file unchanged", () => {
    const text = JSON.stringify({ enabled: true });
    writeFileSync(path, text);
    const result = updateConnectorInstance(path, BUILT_IN_CONNECTORS, "github-event", { settings: { toleranceSeconds: 5 } });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(updateConnectorInstance(path, BUILT_IN_CONNECTORS, "github-event", { settings: { other: 1 } })).toMatchObject({ ok: false, reason: "invalid" });
    expect(updateConnectorInstance(path, BUILT_IN_CONNECTORS, "github-event", { secretName: "lower-case" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("refuses to overwrite a broken config file", () => {
    for (const text of ["{ not json", "[]", JSON.stringify({ merge: { method: "fast-forward" } })]) {
      writeFileSync(path, text);
      const result = updateConnectorInstance(path, BUILT_IN_CONNECTORS, "github-event", { enabled: true });
      expect(result).toMatchObject({ ok: false, reason: "invalid", error: expect.stringContaining("fix the config file first") });
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it("reports an id that no connector has", () => {
    expect(updateConnectorInstance(path, BUILT_IN_CONNECTORS, "nope", { enabled: true })).toMatchObject({ ok: false, reason: "unknown" });
    expect(updateConnectorInstance(path, BUILT_IN_CONNECTORS, "__proto__", { enabled: true })).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("writes the file owner-only and atomically", () => {
    writeFileSync(path, "{}", { mode: 0o644 });
    updateConnectorInstance(path, BUILT_IN_CONNECTORS, "github-event", { enabled: true, secretName: "MY_HUB_SECRET" });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(read().connectors["github-event"].secretName).toBe("MY_HUB_SECRET");
    expect(readdirSync(dir)).toEqual(["pr-orchestrator.json"]);
  });

  it("returns the version that the live config source computes", () => {
    const result = updateConnectorInstance(path, BUILT_IN_CONNECTORS, "github-event", { enabled: true });
    expect(result).toMatchObject({ ok: true, version: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
