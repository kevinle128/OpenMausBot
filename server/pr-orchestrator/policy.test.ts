import { describe, expect, it } from "vitest";
import {
  configValue, describeRoutine, evaluate, predicateHolds, resolveValue, routineMatches, TRIGGER_PHRASES,
  type EvaluateInput,
} from "./policy.ts";
import type { CommandAction, FactMap, OmbEvent, Predicate, RepoConfig, Routine, RoutineAction } from "./types.ts";
import { FACT_NAMES, TRIGGER_NAMES } from "./types.ts";

function makeFacts(over: Partial<FactMap> = {}): FactMap {
  const facts = Object.fromEntries(FACT_NAMES.map(name => [name, null])) as FactMap;
  return { ...facts, ...over };
}

type Schedule = Extract<RoutineAction, { schedule: string }>;

const config = {
  merge: { auto: true },
  commands: { concurrency: 4 },
  workflows: { ciFix: { workflow: "ci-fix" } },
  routines: [],
} as unknown as RepoConfig;

type RoutineDraft = Partial<Omit<Routine, "then">> & { steps?: Routine["then"] };

function routine(over: RoutineDraft = {}): Routine {
  const { steps, ...rest } = over;
  const base = { id: "r1", name: "R1", active: true, when: { on: ["pr.ci.finished"] }, once: "per-trigger" } satisfies Omit<Routine, "then">;
  // oxlint-disable-next-line unicorn/no-thenable -- the routine model names its action list "then"
  return { ...base, then: steps ?? [{ do: "Notify", params: { kind: "merged" } }], ...rest };
}

function matchInput(over: Partial<Parameters<typeof routineMatches>[1]> = {}) {
  return {
    trigger: "pr.ci.finished", connector: "github-event", provider: "github" as const, repo: "acme/widgets",
    event: null, facts: makeFacts(), config, ...over,
  };
}

function evalInput(routines: Routine[], over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    routines, triggerSeq: 7, subjectKey: "github:acme/widgets#1", headSha: "aaa", ...matchInput(), ...over,
  };
}

describe("routineMatches", () => {
  it("fires a routine only for its triggers, or for every trigger with a star", () => {
    expect(routineMatches(routine(), matchInput())).toBe(true);
    expect(routineMatches(routine(), matchInput({ trigger: "pr.pushed" }))).toBe(false);
    const star = routine({ when: { on: ["*"] } });
    expect(routineMatches(star, matchInput({ trigger: "pr.pushed" }))).toBe(true);
    expect(routineMatches(star, matchInput({ trigger: "timer.fired" }))).toBe(true);
  });

  it("narrows a routine by provider and repo glob", () => {
    const r = routine({ when: { on: ["*"], providers: ["gitlab"], repos: ["vtc/3q/**"] } });
    expect(routineMatches(r, matchInput({ provider: "gitlab", repo: "vtc/3q/server/api" }))).toBe(true);
    expect(routineMatches(r, matchInput({ provider: "github", repo: "vtc/3q/server/api" }))).toBe(false);
    expect(routineMatches(r, matchInput({ provider: "gitlab", repo: "vtc/other/api" }))).toBe(false);
    expect(routineMatches(routine({ when: { on: ["*"], providers: [], repos: [] } }), matchInput())).toBe(true);
  });

  it("keeps a routine with provider or repo filters away from a subject that is not a PR", () => {
    const generic = matchInput({ provider: null, repo: null, connector: "slack" });
    expect(routineMatches(routine({ when: { on: ["*"], providers: ["github"] } }), generic)).toBe(false);
    expect(routineMatches(routine({ when: { on: ["*"], repos: ["**"] } }), generic)).toBe(false);
    expect(routineMatches(routine({ when: { on: ["*"] } }), generic)).toBe(true);
  });

  it("matches a connector filter only for events of that connector", () => {
    const r = routine({ when: { on: ["*"], connectors: ["github-event"] } });
    expect(routineMatches(r, matchInput())).toBe(true);
    expect(routineMatches(r, matchInput({ connector: "gitlab-event" }))).toBe(false);
    expect(routineMatches(r, matchInput({ connector: null, trigger: "timer.fired" }))).toBe(false);
    expect(routineMatches(routine({ when: { on: ["*"], connectors: [] } }), matchInput({ connector: null }))).toBe(true);
  });

  it("needs every predicate to hold and treats an empty list as true", () => {
    const facts = makeFacts({ state: "ready", draft: false });
    const holds: Predicate = { fact: "state", op: "eq", value: "ready" };
    const fails: Predicate = { fact: "draft", op: "truthy" };
    expect(routineMatches(routine({ when: { on: ["*"], all: [] } }), matchInput({ facts }))).toBe(true);
    expect(routineMatches(routine({ when: { on: ["*"], all: [holds] } }), matchInput({ facts }))).toBe(true);
    expect(routineMatches(routine({ when: { on: ["*"], all: [holds, fails] } }), matchInput({ facts }))).toBe(false);
  });

  it("skips an inactive routine", () => {
    expect(routineMatches(routine({ active: false }), matchInput())).toBe(false);
    expect(evaluate(evalInput([routine({ active: false })])).intents).toEqual([]);
  });

  it("reads a field of the event data by path", () => {
    const event = { data: { check: { status: "failed" } } } as unknown as OmbEvent;
    const r = routine({ when: { on: ["*"], all: [{ fact: "event.data.check.status", op: "eq", value: "failed" }] } });
    expect(routineMatches(r, matchInput({ event }))).toBe(true);
    expect(routineMatches(r, matchInput({ event: null }))).toBe(false);
    expect(routineMatches(r, matchInput({ event: { data: {} } as unknown as OmbEvent }))).toBe(false);
  });
});

describe("predicateHolds", () => {
  it("compares a fact with a config value by path", () => {
    const p: Predicate = { fact: "run.activeCount", op: "lt", value: { config: "commands.concurrency" } };
    expect(predicateHolds(p, makeFacts({ "run.activeCount": 3 }), config)).toBe(true);
    expect(predicateHolds(p, makeFacts({ "run.activeCount": 4 }), config)).toBe(false);
  });

  it("compares a fact with another fact", () => {
    const p: Predicate = { fact: "ci.failingCount", op: "gte", value: { fact: "run.activeCount" } };
    expect(predicateHolds(p, makeFacts({ "ci.failingCount": 2, "run.activeCount": 2 }), config)).toBe(true);
  });

  it("reads a config flag as a fact name", () => {
    expect(predicateHolds({ fact: "config.merge.auto", op: "truthy" }, makeFacts(), config)).toBe(true);
    expect(predicateHolds({ fact: "config.merge.auto", op: "falsy" }, makeFacts(), config)).toBe(false);
    expect(predicateHolds({ fact: "config.workflows.ciFix.workflow", op: "eq", value: "ci-fix" }, makeFacts(), config)).toBe(true);
  });

  it("is false, not an error, for a missing fact, a missing config path or a number compared with a string", () => {
    const facts = makeFacts({ state: "ready", "run.activeCount": 2 });
    expect(predicateHolds({ fact: "config.nope.deep", op: "eq", value: "x" }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "config.nope.deep", op: "ne", value: "x" }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "config.nope.deep", op: "truthy" }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "config.nope.deep", op: "falsy" }, facts, config)).toBe(true);
    expect(predicateHolds({ fact: "not.a.fact" as never, op: "gt", value: 1 }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "run.activeCount", op: "lt", value: "10" }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "state", op: "gt", value: 1 }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "run.activeCount", op: "gt", value: { config: "missing" } }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "state", op: "in", value: "ready" }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "config.merge", op: "eq", value: { fact: "state" } }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "config.__proto__.x", op: "truthy" }, facts, config)).toBe(false);
  });

  it("supports equality, inequality, ordering and membership", () => {
    const facts = makeFacts({ state: "ready", "run.activeCount": 2 });
    expect(predicateHolds({ fact: "state", op: "eq", value: "ready" }, facts, config)).toBe(true);
    expect(predicateHolds({ fact: "state", op: "ne", value: "ready" }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "run.activeCount", op: "lte", value: 2 }, facts, config)).toBe(true);
    expect(predicateHolds({ fact: "run.activeCount", op: "gt", value: 2 }, facts, config)).toBe(false);
    expect(predicateHolds({ fact: "state", op: "in", value: ["ready", "merging"] }, facts, config)).toBe(true);
    expect(predicateHolds({ fact: "state", op: "in", value: ["open"] }, facts, config)).toBe(false);
  });
});

describe("values and paths", () => {
  it("reads a dotted config path and returns undefined for a missing one", () => {
    expect(configValue(config, "workflows.ciFix.workflow")).toBe("ci-fix");
    expect(configValue(config, "workflows.ciFix.nope")).toBeUndefined();
    expect(configValue(config, "merge.auto.deeper")).toBeUndefined();
    expect(configValue(config, "")).toBeUndefined();
  });

  it("treats an object as a reference only when it has exactly one config or fact key with a string", () => {
    const facts = makeFacts({ state: "ready" });
    expect(resolveValue({ config: "merge.auto" }, facts, config)).toBe(true);
    expect(resolveValue({ fact: "state" }, facts, config)).toBe("ready");
    expect(resolveValue({ config: "merge.auto", extra: 1 }, facts, config)).toEqual({ config: "merge.auto", extra: 1 });
    expect(resolveValue({ config: 5 }, facts, config)).toEqual({ config: 5 });
    expect(resolveValue(["a"], facts, config)).toEqual(["a"]);
    expect(resolveValue(undefined, facts, config)).toBeUndefined();
  });
});

describe("evaluate", () => {
  it("keeps routine order and action order in the intents", () => {
    const first = routine({ id: "first", steps: [{ do: "Notify", params: { kind: "merged" } }, { cancel: "all" }] });
    const second = routine({ id: "second", steps: [{ do: "Merge" }] });
    const result = evaluate(evalInput([first, second]));
    expect(result.matched).toEqual(["first", "second"]);
    expect(result.intents.map(i => [i.routineId, i.actionIndex])).toEqual([["first", 0], ["first", 1], ["second", 0]]);
  });

  it("builds the same key for the same head and a new key for a new head", () => {
    const r = routine({ once: "per-head" });
    const a = evaluate(evalInput([r], { triggerSeq: 1, headSha: "aaa" })).intents[0]?.idemKey;
    const again = evaluate(evalInput([r], { triggerSeq: 99, headSha: "aaa" })).intents[0]?.idemKey;
    const other = evaluate(evalInput([r], { triggerSeq: 1, headSha: "bbb" })).intents[0]?.idemKey;
    expect(a).toBe("github:acme/widgets#1|r1|aaa|0");
    expect(again).toBe(a);
    expect(other).not.toBe(a);
    expect(evaluate(evalInput([r], { headSha: null })).intents[0]?.idemKey).toBe("github:acme/widgets#1|r1|nohead|0");
  });

  it("builds a key per trigger or per PR", () => {
    expect(evaluate(evalInput([routine({ once: "per-trigger" })], { triggerSeq: 12 })).intents[0]?.idemKey).toBe("github:acme/widgets#1|r1|12|0");
    const perPr = routine({ once: "per-pr" });
    expect(evaluate(evalInput([perPr], { triggerSeq: 1, headSha: "x" })).intents[0]?.idemKey)
      .toBe(evaluate(evalInput([perPr], { triggerSeq: 2, headSha: "y" })).intents[0]?.idemKey);
  });

  it("shares one key between routines of the same once group", () => {
    const a = routine({ id: "a", onceGroup: "tell", once: "per-head" });
    const b = routine({ id: "b", onceGroup: "tell", once: "per-head" });
    const keys = evaluate(evalInput([a, b])).intents.map(i => i.idemKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe("github:acme/widgets#1|tell|aaa|0");
  });

  it("gives two actions of one routine different keys", () => {
    const r = routine({ steps: [{ do: "Notify", params: { kind: "merged" } }, { do: "Merge" }] });
    const keys = evaluate(evalInput([r])).intents.map(i => i.idemKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("gives a cancel action no key", () => {
    const result = evaluate(evalInput([routine({ steps: [{ cancel: "merge.window" }] })]));
    expect(result.intents[0]).toMatchObject({ idemKey: null, action: { cancel: "merge.window" } });
  });

  it("passes the ask-first flag through to the intent", () => {
    const r = routine({ steps: [{ do: "Merge", askFirst: true }, { do: "Notify", params: { kind: "merged" } }] });
    const intents = evaluate(evalInput([r])).intents;
    expect(intents[0]?.action).toMatchObject({ do: "Merge", askFirst: true });
    expect(intents[1]?.action).not.toHaveProperty("askFirst");
  });

  it("drops a schedule whose delay does not resolve to a positive number", () => {
    const bad = (afterMinutes: Schedule["afterMinutes"]) =>
      routine({ id: "s", steps: [{ schedule: "merge.window", afterMinutes }, { do: "Merge" }] });
    for (const afterMinutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, { fact: "merge.minutesToWindow" as const }, { config: "missing.path" }]) {
      const result = evaluate(evalInput([bad(afterMinutes)], { facts: makeFacts({ "merge.minutesToWindow": null }) }));
      expect(result.intents.map(i => i.actionIndex)).toEqual([1]);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]?.routineId).toBe("s");
    }
  });

  it("keeps a schedule whose delay resolves to a positive number", () => {
    const r = routine({ steps: [{ schedule: "merge.window", afterMinutes: { fact: "merge.minutesToWindow" } }] });
    const result = evaluate(evalInput([r], { facts: makeFacts({ "merge.minutesToWindow": 90 }) }));
    expect(result.skipped).toEqual([]);
    expect(result.intents[0]?.action).toEqual({ schedule: "merge.window", afterMinutes: 90 });
  });

  it("has no side effects on its input", () => {
    const routines = [routine({ steps: [{ schedule: "merge.window", afterMinutes: { fact: "merge.minutesToWindow" } }] })];
    const snapshot = JSON.stringify(routines);
    evaluate(evalInput(routines, { facts: makeFacts({ "merge.minutesToWindow": 5 }) }));
    expect(JSON.stringify(routines)).toBe(snapshot);
  });
});

describe("describeRoutine", () => {
  const describeAction = (a: CommandAction) => (a.do === "RunWorkflow" ? "run workflow ci-fix (one active run per PR)" : `do ${a.do}`);
  const noTitle = () => null;

  it("describes a routine in one sentence with its filters, conditions and actions", () => {
    const r = routine({
      when: {
        on: ["pr.ci.finished"], providers: ["gitlab"], repos: ["vtc/3q/**"],
        all: [{ fact: "trigger.ci.status", op: "eq", value: "failed" }],
      },
      steps: [{ do: "RunWorkflow" }],
    });
    expect(describeRoutine(r, describeAction, noTitle)).toBe(
      "When CI finishes (pr.ci.finished), on gitlab, repos vtc/3q/**, if trigger.ci.status = failed: run workflow ci-fix (one active run per PR).",
    );
  });

  it("shows value references, set tests, ask first and timer steps", () => {
    const r = routine({
      when: {
        on: ["*"],
        all: [
          { fact: "run.activeCount", op: "lt", value: { config: "commands.concurrency" } },
          { fact: "config.merge.auto", op: "truthy" },
          { fact: "merge.quietNow", op: "falsy" },
          { fact: "state", op: "in", value: ["ready", "merging"] },
        ],
      },
      steps: [{ do: "Merge", askFirst: true }, { schedule: "merge.window", afterMinutes: { fact: "merge.minutesToWindow" } }, { cancel: "all" }],
    });
    expect(describeRoutine(r, describeAction, noTitle)).toBe(
      "When anything happens, if run.activeCount < config commands.concurrency and config.merge.auto is set and merge.quietNow is not set and state in [\"ready\",\"merging\"]: "
      + "do Merge (ask first); start the merge.window timer after fact merge.minutesToWindow minutes; cancel all timers.",
    );
  });

  it("uses the connector's event title first, then the phrase list, then the raw type", () => {
    const r = routine({ when: { on: ["pr.ci.finished", "chat.message.posted"], connectors: ["slack"] } });
    const titles = (connector: string | null, type: string) => (connector === "slack" && type === "pr.ci.finished" ? "Build done" : null);
    expect(describeRoutine(r, describeAction, titles)).toContain("When Build done (pr.ci.finished) or chat.message.posted, from slack");
    expect(describeRoutine(r, describeAction, noTitle)).toContain("When CI finishes (pr.ci.finished) or chat.message.posted");
  });

  it("has a phrase for every trigger", () => {
    expect(Object.keys(TRIGGER_PHRASES).sort()).toEqual([...TRIGGER_NAMES].sort());
    for (const trigger of TRIGGER_NAMES) {
      expect(describeRoutine(routine({ when: { on: [trigger] } }), describeAction, noTitle)).toContain(TRIGGER_PHRASES[trigger]);
    }
  });
});
