/* oxlint-disable unicorn/no-thenable -- a routine's action list is named "then" in the config document */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseOrchestratorConfig } from "./config.ts";
import { BUILT_IN_CONNECTORS } from "./connectors/index.ts";
import { createOrchestratorCore, type OrchestratorCore } from "./core.ts";
import { DEFAULT_ROUTINES } from "./default-routines.ts";
import type { CommandHandlers } from "./handlers.ts";
import { parseNdjsonInputs, mismatchesOf } from "./replay.ts";
import { contractPart, InvalidRoutineError, replayRecorded, simulate, testRoutine, toSimInputs, type SimInput } from "./simulate.ts";
import { counterIds, DEFAULT_PR_KEY, ev, fakeClock, SHA_A, SHA_B, T0 } from "./testing/builders.ts";
import { manualTimer } from "./testing/manual-timer.ts";
import { scriptedHandlers } from "./testing/recording-ports.ts";
import type { CoreInput, OmbEvent, OrchestratorConfig, Routine } from "./types.ts";

function configOf(doc: Record<string, unknown> = {}): OrchestratorConfig {
  const parsed = parseOrchestratorConfig(JSON.stringify({ enabled: true, ...doc }), BUILT_IN_CONNECTORS);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.config;
}

const event = (e: OmbEvent, at: number): SimInput => ({ at, connector: e.connector, event: contractPart(e) });
const input = (at: number, body: CoreInput, prKey = DEFAULT_PR_KEY): SimInput => ({ at, prKey, input: body });
const WITH_WORKFLOW = { workflows: { ciFix: { workflow: "ci-fix" } } };
const FORGE_B = { headSha: SHA_B, mergeable: true, blockers: [], requiredChecks: null, baseFailing: [], failedJobs: [] };

/** The stream of a PR that fails CI, gets a fix, passes CI and review, and is merged. */
function happyPath(): SimInput[] {
  return parseNdjsonInputs(readFileSync(new URL("./testing/fixtures/happy-path.ndjson", import.meta.url), "utf8"));
}

const ciFailedStream = (): SimInput[] => [event(ev.opened(), T0), event(ev.ciFinished({ status: "failed", failedJobs: ["unit"] }), T0 + 1000)];

let dir: string | null = null;
let core: OrchestratorCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const TABLES = ["meta", "received_events", "ledger", "prs", "commands", "timers", "config_versions", "connector_log", "connector_cursors"];
function rowCounts(path: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(TABLES.map(table => [table, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)]));
  } finally {
    db.close();
  }
}

describe("routine test run", () => {
  it("tests a draft routine on a stored event without touching the live store", async () => {
    dir = mkdtempSync(join(tmpdir(), "pr-orchestrator-sim-"));
    const timer = manualTimer();
    const clock = fakeClock();
    core = createOrchestratorCore({
      dbPath: join(dir, "pr-orchestrator.db"), configPath: join(dir, "missing.json"), now: clock.now, newId: counterIds("c"), startTimer: timer.startTimer,
    });
    core.start();
    core.intake.accept([ev.opened(), ev.ciFinished({ status: "failed" })].map(e => ({ event: e, raw: "{}" })), clock.now());
    await timer.options().run();
    const ledger = core.pr(DEFAULT_PR_KEY)?.ledger ?? [];
    const failedInput = ledger.filter(row => row.causationSeq === null && row.entry.type === "event.received").at(-1);
    expect(failedInput).toBeDefined();
    const before = rowCounts(join(dir, "pr-orchestrator.db"));

    const draft: Routine = {
      id: "draft-ci-notice", name: "Notice on failed CI", active: true,
      when: { on: ["pr.ci.finished"], all: [{ fact: "trigger.ci.status", op: "eq", value: "failed" }] },
      then: [{ do: "Notify", params: { kind: "review_failed" } }], once: "per-trigger",
    };
    const result = await core.testRoutine({ routine: draft, prKey: DEFAULT_PR_KEY, inputSeq: failedInput!.seq });

    expect(result.matched).toBe(true);
    expect(result.actions).toEqual([expect.objectContaining({ action: "Notify", askFirst: false, payload: { type: "Notify", kind: "review_failed" } })]);
    expect(result.describe).toContain("When CI finishes");
    expect(rowCounts(join(dir, "pr-orchestrator.db"))).toEqual(before);
  });

  it("shows the facts and the payloads a routine would build at that event", async () => {
    const fix = DEFAULT_ROUTINES.find(routine => routine.id === "run-ci-fix-workflow") as Routine;
    const result = await testRoutine({ config: configOf(WITH_WORKFLOW), inputs: ciFailedStream(), routine: fix, inputIndex: 1 });
    expect(result.matched).toBe(true);
    expect(result.facts).toMatchObject({ state: "ci_failed", "trigger.isHead": true, "trigger.ci.status": "failed" });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.payload).toMatchObject({ type: "RunWorkflow", guard: "workflow:ci-fix", workflow: "ci-fix", headSha: SHA_A });
  });

  it("reports no match when the routine's repo filter excludes the PR", async () => {
    const other: Routine = {
      id: "other-repo", name: "Other repo", active: true,
      when: { repos: ["somewhere/else"], on: ["pr.ci.finished"] }, then: [{ do: "Notify", params: { kind: "review_failed" } }], once: "per-trigger",
    };
    const result = await testRoutine({ config: configOf(), inputs: ciFailedStream(), routine: other, inputIndex: 1 });
    expect(result).toMatchObject({ matched: false, actions: [] });
    expect(result.facts).not.toBeNull();
  });

  it("refuses a draft that the config schema refuses", async () => {
    const broken = { id: "broken", name: "Broken", active: true, when: { on: ["not.a.type"] }, then: [{ do: "Notify", params: { kind: "merged" } }], once: "per-trigger" } as unknown as Routine;
    await expect(testRoutine({ config: configOf(), inputs: ciFailedStream(), routine: broken, inputIndex: 1 })).rejects.toBeInstanceOf(InvalidRoutineError);
  });
});

describe("simulator", () => {
  it("gives the same ledger for the same inputs", async () => {
    const config = configOf(WITH_WORKFLOW);
    const first = await simulate({ inputs: happyPath(), config });
    const second = await simulate({ inputs: happyPath(), config });
    expect(second).toEqual(first);
    expect(first.ledger.length).toBeGreaterThan(10);
    expect(mismatchesOf(first.prs, first.ledger)).toEqual([]);
  });

  it("drops recorded timer and command results in simulated mode and applies them once in recorded mode", async () => {
    const config = configOf(WITH_WORKFLOW);
    const base = ciFailedStream();
    const { commands } = await simulate({ inputs: base, config });
    const run = commands[0]!;
    expect(run.type).toBe("RunWorkflow");
    const recorded = input(T0 + 2000, {
      type: "command.finished", commandId: "an-id-from-another-run", command: "RunWorkflow", payload: run.payload,
      result: { outcome: "succeeded", detail: { runRef: "run-9" } },
    });
    const withResults = [...base, recorded, input(T0 + 3000, { type: "timer.fired", timerId: "t-old", kind: "merge.window" })];
    const finishedOf = (ledger: Array<{ entry: { type: string } }>) => ledger.filter(row => row.entry.type === "command.finished");

    const simulated = await simulate({ inputs: withResults, config });
    expect(finishedOf(simulated.ledger)).toHaveLength(1);
    expect(simulated.commands[0]?.outcome).toBe("skipped");

    const replayed = replayRecorded({ inputs: withResults, config });
    const finished = finishedOf(replayed.ledger);
    expect(finished).toHaveLength(1);
    expect(replayed.commands[0]).toMatchObject({ status: "done", outcome: "succeeded" });
    expect(replayed.prs[0]?.activeRuns).toMatchObject({ "workflow:ci-fix": { status: "running", runRef: "run-9" } });
  });

  it("matches a recorded ask-first answer again on replay", () => {
    const config = configOf({
      routines: { custom: [{
        id: "ask-before-merge", name: "Ask before merge", active: true,
        when: { on: ["pr.opened"] }, then: [{ do: "Merge", askFirst: true }], once: "per-head",
      }] },
    });
    const decisionId = `${DEFAULT_PR_KEY}|ask-before-merge|${SHA_A}|0#approve`;
    const result = replayRecorded({ inputs: [event(ev.opened(), T0), input(T0 + 1000, { type: "person.answered", decisionId, answer: "approve" })], config });
    const types = result.ledger.map(row => row.entry.type);
    expect(types).toContain("command.gated");
    expect(types.filter(type => type === "command.issued")).toHaveLength(2);
    const merge = result.commands.find(command => command.type === "Merge");
    expect(merge).toMatchObject({ status: "pending", approvalId: null });
  });

  it("fires the merge window on the virtual clock", async () => {
    const config = configOf({ merge: { quietHours: { start: "22:00", end: "07:00", timeZone: "Asia/Saigon" } } });
    const at = Date.parse("2026-11-22T16:00:00Z");
    const handlers: Partial<CommandHandlers> = scriptedHandlers({
      RefreshDetails: () => ({ outcome: "succeeded", detail: { forge: { ...FORGE_B, headSha: SHA_A } } }),
      Merge: () => ({ outcome: "succeeded", detail: { merged: false, sha: null } }),
    });
    const result = await simulate({
      inputs: [event(ev.opened(), at), event(ev.ciFinished(), at + 1000), event(ev.reviewFinished(), at + 2000)], config, handlers,
    });
    const [window] = result.timers;
    expect(result.timers).toHaveLength(1);
    expect(window).toMatchObject({ kind: "merge.window", state: "fired" });
    expect(window!.dueAt - window!.createdAt).toBe(8 * 3600 * 1000);
    const merges = result.commands.filter(command => command.type === "Merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]!.createdAt).toBe(window!.dueAt);
  });

  it("reaches merging with succeeding handlers and stays short of it with the stubs", async () => {
    const config = configOf(WITH_WORKFLOW);
    const succeeding = scriptedHandlers({
      RunWorkflow: () => ({ outcome: "succeeded", detail: { runRef: "run-1" } }),
      RefreshDetails: () => ({ outcome: "succeeded", detail: { forge: FORGE_B } }),
      Merge: () => ({ outcome: "succeeded", detail: { merged: false, sha: null } }),
    });
    const merged = await simulate({ inputs: happyPath(), config, handlers: succeeding });
    const states = (ledger: typeof merged.ledger) => ledger.flatMap(row => (row.entry.type === "state.changed" ? [row.entry.to] : []));
    expect(states(merged.ledger)).toEqual(["ci_running", "ci_failed", "fixing", "ci_running", "reviewing", "ready", "merging"]);
    expect(merged.commands.map(command => command.type)).toEqual(["RunWorkflow", "RefreshDetails", "Merge"]);

    const stubbed = await simulate({ inputs: happyPath(), config });
    expect(states(stubbed.ledger)).not.toContain("merging");
    expect(stubbed.commands.length).toBeGreaterThan(0);
    expect(stubbed.commands.every(command => command.outcome === "skipped")).toBe(true);
    expect(mismatchesOf(stubbed.prs, stubbed.ledger)).toEqual([]);
  });
});

describe("recorded inputs", () => {
  it("finishes a held command once when its approval is never asked", async () => {
    const config = configOf({
      routines: { custom: [{
        id: "ask-before-merge", name: "Ask before merge", active: true,
        when: { on: ["pr.opened"] }, then: [{ do: "Merge", askFirst: true }], once: "per-head",
      }] },
    });
    const first = await simulate({ inputs: [event(ev.opened(), T0)], config });
    const finishedFor = (ledger: typeof first.ledger) => ledger.filter(row => row.entry.type === "command.finished").map(row => (row.entry as { command: string }).command);
    expect(finishedFor(first.ledger).sort()).toEqual(["AskPerson", "Merge"]);

    const stored = toSimInputs(first.ledger);
    const replayed = replayRecorded({ inputs: stored, config });
    expect(finishedFor(replayed.ledger).sort()).toEqual(["AskPerson", "Merge"]);
    expect(mismatchesOf(replayed.prs, replayed.ledger)).toEqual([]);
  });
});
