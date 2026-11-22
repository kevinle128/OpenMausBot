/* oxlint-disable unicorn/no-thenable -- a routine's action list is named "then" in the config document */
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { configJsonSchema, configVersion, createConfigSource, parseOrchestratorConfig, resolveForRepo, resolveRoutines } from "./config.ts";
import { BUILT_IN_CONNECTORS } from "./connectors/index.ts";
import { DEFAULT_ROUTINES } from "./default-routines.ts";
import { DEFAULT_MESSAGES } from "./messages.ts";
import type { ConnectorDefinition } from "./ports.ts";
import type { OrchestratorConfig, Routine } from "./types.ts";

const fake: ConnectorDefinition<{ toleranceSeconds: number }> = {
  id: "fake-event", title: "Fake", description: "A connector for tests", icon: { glyph: "F" },
  emits: ["pr.opened", "pr.ci.finished", "pr.conflict.detected"], delivery: "inbound-http",
  settingsSchema: z.strictObject({ toleranceSeconds: z.number().int().positive().default(300) }),
  secret: { required: true, defaultName: "FAKE_EVENT_SECRET" },
  defaultInstance: { enabled: false, settings: { toleranceSeconds: 300 } },
};
const connectors = [fake as ConnectorDefinition];

function parse(document: unknown, registry: readonly ConnectorDefinition[] = connectors): OrchestratorConfig {
  const result = parseOrchestratorConfig(JSON.stringify(document), registry);
  if (!result.ok) throw new Error(result.error);
  return result.config;
}
function refusal(document: unknown, registry: readonly ConnectorDefinition[] = connectors): string {
  const result = parseOrchestratorConfig(JSON.stringify(document), registry);
  if (result.ok) throw new Error("the document was accepted");
  return result.error;
}
const routine = (id: string, extra: Partial<Routine> = {}): Routine => ({
  id, name: id, active: true, when: { on: ["pr.opened"] }, then: [{ do: "Merge" }], once: "per-pr", ...extra,
});

describe("config document", () => {
  it("fills every default from an empty document and keeps the core off", () => {
    const config = parse({});
    expect(config.enabled).toBe(false);
    expect(config.readiness).toEqual({ requiredChecks: [], compareBase: true, requireReview: true, requireReviewedHead: true, requireMergeable: true });
    expect(config.merge.quietHours).toBeNull();
    expect(config.escalation).toEqual({ decision: true, notifier: "inbox", digestMinutes: 0 });
    expect(config.commands).toEqual({ maxAttempts: 6, backoffSeconds: { initial: 30, max: 1800 }, concurrency: 4 });
    expect(config.retention).toEqual({ endedPrDays: 180, receivedEventDays: 90 });
    expect(config.messages).toEqual(DEFAULT_MESSAGES);
    expect(config.routines).toEqual({ useDefaults: true, custom: [], deactivate: [] });
    expect(config.overrides).toEqual([]);
  });

  it("keeps squash, auto-merge and an empty fix workflow as the defaults", () => {
    const config = parse({});
    expect(config.merge).toMatchObject({ auto: true, method: "squash", deleteBranch: true });
    expect(config.workflows.ciFix).toEqual({
      workflow: "", connection: null, message: "CI failed on {{repo}}#{{number}} at {{headSha}}: {{failedChecks}}. {{url}}",
    });
    expect(parse({ messages: { merged: "Done {{mergeSha}}" } }).messages).toEqual({ ...DEFAULT_MESSAGES, merged: "Done {{mergeSha}}" });
  });

  it("refuses an unknown key, a duplicate routine id and a fact name that does not exist", () => {
    for (const key of ["fixLoop", "owners", "scope"]) expect(refusal({ [key]: {} })).toContain(key);
    expect(refusal({ readiness: { flaky: [] } })).toContain("flaky");
    expect(refusal({ routines: { custom: [routine("a"), routine("a")] } })).toContain("duplicates the routine id a");
    const badFact = routine("b", { when: { on: ["pr.opened"], all: [{ fact: "nope" as never, op: "truthy" }] } });
    expect(refusal({ routines: { custom: [badFact] } })).toContain("routines.custom.0.when.all.0.fact");
    const emptyConfigPath = routine("c", { when: { on: ["pr.opened"], all: [{ fact: "config.", op: "truthy" }] } });
    expect(refusal({ routines: { custom: [emptyConfigPath] } })).toContain("not a known fact");
    expect(parse({ routines: { custom: [routine("d", { when: { on: ["pr.opened"], all: [{ fact: "event.data.check.name", op: "eq", value: "lint" }] } })] } }).routines.custom).toHaveLength(1);
  });

  it("refuses bad values with the path of the field", () => {
    expect(refusal({ merge: { quietHours: { start: "25:00", end: "07:00", timeZone: "Asia/Saigon" } } })).toContain("merge.quietHours.start");
    expect(refusal({ merge: { quietHours: { start: "22:00", end: "07:00", timeZone: "Mars/Base" } } })).toContain("merge.quietHours.timeZone");
    expect(parse({ merge: { quietHours: { start: "22:00", end: "07:00", timeZone: "Asia/Saigon" } } }).merge.quietHours?.timeZone).toBe("Asia/Saigon");
    expect(refusal({ commands: { maxAttempts: 0 } })).toContain("commands.maxAttempts");
    expect(refusal({ merge: { method: "fast-forward" } })).toContain("merge.method");
    expect(refusal({ workflows: { ciFix: { message: "CI {{nope}}" } } })).toContain("unknown placeholder nope");
    expect(refusal({ routines: { custom: [routine("x", { then: [{ do: "Instruct", params: { to: "owner", prompt: "{{nope}}" } }] })] } })).toContain("unknown placeholder nope");
    expect(refusal({ routines: { custom: [routine("Not Kebab")] } })).toContain("kebab-case");
    expect(refusal({ routines: { deactivate: ["no-such-default"] } })).toContain("not a default routine");
  });

  it("refuses more than fifty routines", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => routine(`custom-${i}`));
    expect(parse({ routines: { useDefaults: false, custom: many(50) } }).routines.custom).toHaveLength(50);
    expect(refusal({ routines: { useDefaults: false, custom: many(51) } })).toContain("at most 50 routines");
    expect(refusal({ routines: { custom: many(50) } })).toContain("at most 50 routines");
  });

  it("gives the same version for the same document with keys in another order", () => {
    const a = parse({ merge: { auto: false, method: "rebase" }, enabled: true });
    const b = parse({ enabled: true, merge: { method: "rebase", auto: false } });
    expect(configVersion(a)).toBe(configVersion(b));
    expect(configVersion(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(configVersion(a)).not.toBe(configVersion(parse({})));
  });

  it("applies matching overrides in order, deep-merging objects and replacing arrays", () => {
    const config = parse({
      readiness: { requiredChecks: ["ci/build"] },
      workflows: { ciFix: { workflow: "ci-fix" } },
      merge: { quietHours: { start: "22:00", end: "07:00", timeZone: "Asia/Saigon" } },
      overrides: [
        { match: { providers: ["gitlab"], repos: ["vtc/3q/**"] }, set: { merge: { auto: false }, readiness: { requiredChecks: ["a/*"] }, workflows: { ciFix: { message: "fix {{url}}" } } } },
        { match: { repos: ["vtc/**"] }, set: { readiness: { requiredChecks: ["b/*", "c/*"] }, merge: { quietHours: null } } },
        { match: { providers: ["github"] }, set: { merge: { method: "merge" } } },
        { match: {}, set: { escalation: { decision: false } } },
      ],
    });
    const gitlab = resolveForRepo(config, "gitlab", "vtc/3q/game");
    expect(gitlab.merge).toEqual({ auto: false, method: "squash", deleteBranch: true, quietHours: null });
    expect(gitlab.readiness.requiredChecks).toEqual(["b/*", "c/*"]);
    expect(gitlab.workflows.ciFix).toMatchObject({ workflow: "ci-fix", message: "fix {{url}}", connection: null });
    expect(gitlab.escalation.decision).toBe(false);
    const github = resolveForRepo(config, "github", "acme/app");
    expect(github.merge).toMatchObject({ auto: true, method: "merge" });
    expect(github.merge.quietHours?.start).toBe("22:00");
    expect(github.readiness.requiredChecks).toEqual(["ci/build"]);
    expect(github).toMatchObject({ enabled: false, commands: config.commands, retention: config.retention });
    expect(config.merge.auto).toBe(true);
  });

  it("replaces a default routine by a custom one with the same id and appends new ones", () => {
    const replacement = routine("merge-when-ready", { name: "Mine" });
    const config = parse({ routines: { custom: [routine("brand-new"), replacement] } });
    const resolved = resolveRoutines(config);
    expect(resolved).toHaveLength(DEFAULT_ROUTINES.length + 1);
    const at = DEFAULT_ROUTINES.findIndex(r => r.id === "merge-when-ready");
    expect(resolved[at]).toMatchObject({ id: "merge-when-ready", name: "Mine", source: "custom" });
    expect(resolved.at(-1)).toMatchObject({ id: "brand-new", source: "custom" });
    expect(resolved[0].source).toBe("default");
    const onlyCustom = resolveRoutines(parse({ routines: { useDefaults: false, custom: [routine("brand-new")] } }));
    expect(onlyCustom.map(r => r.id)).toEqual(["brand-new"]);
  });

  it("keeps a deactivated default routine in the list as inactive", () => {
    const resolved = resolveRoutines(parse({ routines: { deactivate: ["merge-when-ready"] } }));
    expect(resolved).toHaveLength(DEFAULT_ROUTINES.length);
    expect(resolved.find(r => r.id === "merge-when-ready")).toMatchObject({ active: false, source: "default" });
    expect(resolved.find(r => r.id === "after-merge")?.active).toBe(true);
    expect(DEFAULT_ROUTINES.find(r => r.id === "merge-when-ready")?.active).toBe(true);
  });

  it("ships the default routines exactly as listed", () => {
    expect(DEFAULT_ROUTINES.map(r => [r.id, r.name])).toEqual([
      ["run-ci-fix-workflow", "Run the CI fix workflow when CI fails"],
      ["tell-owner-conflict", "Tell the owner about a merge conflict"],
      ["ask-person-review-decision", "Ask the person about a review decision"],
      ["notify-review-chain-failed", "Notify when the review chain failed"],
      ["tell-owner-decision", "Send the person's answer to the owner"],
      ["refresh-forge-before-merge", "Read the forge facts before a merge"],
      ["merge-when-ready", "Merge when ready"],
      ["wait-for-merge-window", "Wait for the end of quiet hours"],
      ["notify-ready-without-auto-merge", "Notify when ready and auto-merge is off"],
      ["after-merge", "After the merge: notify, and tell the owner if found"],
      ["stop-timers-on-close", "Stop timers when the PR closes"],
      ["ask-person-command-failed", "Ask the person when an action failed"],
    ]);
  });
});

describe("connectors in the config document", () => {
  it("fills a connector's default instance and checks its settings with the connector's schema", () => {
    const config = parse({});
    expect(config.connectors["fake-event"]).toEqual({ use: "fake-event", enabled: false, secretName: "FAKE_EVENT_SECRET", settings: { toleranceSeconds: 300 } });
    const custom = parse({ connectors: { "fake-event": { use: "fake-event", enabled: true, settings: {} }, second: { use: "fake-event", settings: { toleranceSeconds: 60 } } } });
    expect(custom.connectors["fake-event"]).toMatchObject({ enabled: true, settings: { toleranceSeconds: 300 } });
    expect(custom.connectors.second).toMatchObject({ enabled: false, settings: { toleranceSeconds: 60 } });
    expect(refusal({ connectors: { second: { use: "fake-event", settings: { toleranceSeconds: -1 } } } })).toContain("connectors.second.settings.toleranceSeconds");
    expect(refusal({ connectors: { second: { use: "fake-event", settings: { other: 1 } } } })).toContain("connectors.second.settings");
  });

  it("refuses an instance whose definition is not registered", () => {
    expect(refusal({ connectors: { mine: { use: "ghost-event" } } })).toContain("ghost-event is not a registered connector");
    expect(refusal({ connectors: { mine: { use: "fake-event" } } }, [])).toContain("fake-event is not a registered connector");
  });

  it("refuses a routine on an event type that its connectors do not declare", () => {
    const onClosed = routine("on-closed", { when: { on: ["pr.closed"] } });
    expect(refusal({ routines: { custom: [onClosed] } })).toContain("pr.closed is not an event type that the selected connectors declare");
    expect(refusal({ routines: { custom: [routine("scoped", { when: { connectors: ["nobody"], on: ["pr.opened"] } })] } })).toContain("nobody is not a configured connector");
    const listening = [routine("a"), routine("b", { when: { on: ["*", "timer.fired", "command.finished"] } }), routine("c", { when: { connectors: ["fake-event"], on: ["pr.ci.finished"] } })];
    expect(parse({ routines: { custom: listening } }).routines.custom).toHaveLength(3);
    expect(refusal({ routines: { custom: [routine("a")] } }, [])).toContain("pr.opened is not an event type");
  });
});

describe("config file source", () => {
  let dir: string;
  let file: string;
  const settle = (offsetSeconds: number) => {
    const at = new Date(Date.now() - offsetSeconds * 1000);
    utimesSync(file, at, at);
  };
  const lines: string[] = [];
  const versions: Array<{ version: string; json: string }> = [];
  const source = () => createConfigSource({ path: () => file, connectors, log: line => lines.push(line), onVersion: (version, json) => versions.push({ version, json }) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pr-orchestrator-config-"));
    file = join(dir, "pr-orchestrator.json");
    lines.length = 0;
    versions.length = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the defaults without an error when the file is missing", () => {
    const current = source().current();
    expect(current.error).toBeNull();
    expect(current.config.enabled).toBe(false);
    expect(versions).toHaveLength(1);
  });

  it("reloads a changed file and reports each new version once", () => {
    const configs = source();
    writeFileSync(file, JSON.stringify({ enabled: true }));
    settle(10);
    const first = configs.current();
    expect(first.config.enabled).toBe(true);
    expect(configs.current().version).toBe(first.version);
    writeFileSync(file, JSON.stringify({ enabled: true, merge: { auto: false } }));
    settle(20);
    const second = configs.current();
    expect(second.config.merge.auto).toBe(false);
    expect(second.version).not.toBe(first.version);
    expect(versions.map(v => v.version)).toEqual([first.version, second.version]);
    expect(JSON.parse(versions[1].json).merge.auto).toBe(false);
  });

  it("keeps the last valid config and reports the error when the file breaks", () => {
    const configs = source();
    writeFileSync(file, JSON.stringify({ enabled: true }));
    settle(10);
    const good = configs.current();
    writeFileSync(file, '{ "enabled": true, "secretish": "do-not-echo", ');
    settle(20);
    const broken = configs.current();
    expect(broken.config).toEqual(good.config);
    expect(broken.version).toBe(good.version);
    expect(broken.error).toBe("the document is not valid JSON");
    writeFileSync(file, JSON.stringify({ merge: { method: "nope" } }));
    settle(30);
    expect(configs.current().error).toContain("merge.method");
    configs.current();
    expect(lines).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("do-not-echo");
    writeFileSync(file, JSON.stringify({ enabled: false }));
    settle(40);
    expect(configs.current().error).toBeNull();
  });

  it("starts from the defaults when the first file is broken", () => {
    writeFileSync(file, "nope");
    settle(10);
    const current = source().current();
    expect(current.error).not.toBeNull();
    expect(current.config.enabled).toBe(false);
  });
});

describe("config JSON Schema", () => {
  it("describes the document as written, with the draft and the strict top level", () => {
    const schema = configJsonSchema(connectors) as { $schema: string; type: string; additionalProperties: unknown; properties: Record<string, unknown> };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["enabled", "connectors", "readiness", "merge", "workflows", "routines", "overrides"]));
    expect(JSON.parse(JSON.stringify(configJsonSchema(connectors)))).toEqual(configJsonSchema(connectors));
  });

  it("matches the committed JSON Schema file", () => {
    const committed = readFileSync(new URL("./config.schema.json", import.meta.url), "utf8");
    expect(committed).toBe(`${JSON.stringify(configJsonSchema(BUILT_IN_CONNECTORS), null, 2)}\n`);
  });
});
