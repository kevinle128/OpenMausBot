import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrchestratorCore } from "./core.ts";
import { exportInputs, parseNdjsonInputs, runReplay, verifyDb } from "./replay.ts";
import { openOrchestratorStore } from "./store.ts";
import { counterIds, DEFAULT_PR_KEY, ev, fakeClock, SHA_B } from "./testing/builders.ts";
import { manualTimer } from "./testing/manual-timer.ts";

const HAPPY = readFileSync(new URL("./testing/fixtures/happy-path.ndjson", import.meta.url), "utf8");
const DEFAULTS_ON = JSON.stringify({ routines: { useDefaults: true } });
let dir: string;
let liveEnv: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pr-orchestrator-replay-"));
  liveEnv = process.env.OMB_DATA_DIR;
});
afterEach(() => {
  if (liveEnv === undefined) delete process.env.OMB_DATA_DIR;
  else process.env.OMB_DATA_DIR = liveEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("replay", () => {
  it("replays an NDJSON stream of hub events and owner inputs", async () => {
    const owner = {
      type: "owner.bound", pr: { provider: "github", repo: "acme/widgets", number: 42, url: null },
      owner: { runtime: "paseo", hostId: "h", agentId: "agent-1", workspaceId: null, projectId: null, harness: null, model: null, boundBy: "claim", boundAt: 0 },
    };
    const text = `${HAPPY}${JSON.stringify({ at: Date.parse("2026-11-22T03:00:06Z"), prKey: "github:acme/widgets#42", input: owner })}\n`;
    expect(parseNdjsonInputs(text)).toHaveLength(7);

    const summary = await runReplay({ eventsText: text, configText: DEFAULTS_ON, mode: "simulated", handlers: "succeed" });
    expect(summary).toMatchObject({ mode: "simulated", inputs: 7, mismatches: [], refused: 0 });
    expect(summary.prs).toEqual([expect.objectContaining({ key: "github:acme/widgets#42", state: "merging", headSha: SHA_B })]);
    expect(summary.commands.map(command => command.type)).toEqual(["RefreshDetails", "Merge"]);

    const stubbed = await runReplay({ eventsText: text, configText: DEFAULTS_ON, mode: "simulated", handlers: "stub" });
    expect(stubbed.prs[0]?.state).not.toBe("merging");

    const recorded = await runReplay({ eventsText: HAPPY, configText: DEFAULTS_ON, mode: "recorded", handlers: "stub" });
    expect(recorded).toMatchObject({ mode: "recorded", mismatches: [] });
  });

  it("names the line of an input it cannot read", () => {
    expect(() => parseNdjsonInputs(`${HAPPY.split("\n")[0]}\n{"nothing":true}\n`)).toThrow("line 2");
    expect(() => parseNdjsonInputs("{not json")).toThrow("line 1");
  });

  it("finds no difference in a copy of a database written by the core", async () => {
    const live = join(dir, "pr-orchestrator.db");
    const timer = manualTimer();
    const clock = fakeClock();
    const configPath = join(dir, "pr-orchestrator.json");
    writeFileSync(configPath, DEFAULTS_ON);
    const core = createOrchestratorCore({
      dbPath: live, configPath, now: clock.now, newId: counterIds("c"), startTimer: timer.startTimer,
    });
    core.start();
    core.intake.accept([ev.opened(), ev.ciFinished({ status: "failed" }), ev.conflict()].map(event => ({ event, raw: "{}" })), clock.now());
    await timer.options().run();
    expect(core.pr(DEFAULT_PR_KEY)?.ledger.length).toBeGreaterThan(3);
    await core.stop();

    process.env.OMB_DATA_DIR = join(dir, "elsewhere");
    const copy = join(dir, "copy.db");
    copyFileSync(live, copy);
    expect(verifyDb(copy)).toEqual([]);
    const exported = exportInputs(copy);
    expect(exported.split("\n")).toHaveLength(4);
    expect(exported).toContain('"type":"command.finished"');
    const summary = await runReplay({ eventsText: exported, configText: DEFAULTS_ON, mode: "recorded", handlers: "stub" });
    expect(summary.mismatches).toEqual([]);
    expect(summary.prs[0]).toMatchObject({ key: DEFAULT_PR_KEY, state: "ci_failed" });
  });

  it("refuses to open the live database", () => {
    process.env.OMB_DATA_DIR = dir;
    const live = join(dir, "pr-orchestrator.db");
    openOrchestratorStore(live).close();
    const link = join(dir, "link.db");
    symlinkSync(live, link);
    for (const path of [live, link]) {
      expect(() => verifyDb(path)).toThrow("live database");
      expect(() => exportInputs(path)).toThrow("live database");
    }
  });
});
