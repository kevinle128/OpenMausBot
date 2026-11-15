import { describe, expect, it, vi } from "vitest";

import { approvingOption, buildGuardState, createJevGuard, decide, GUARD_QUESTIONS, scoresLine, type GuardScores } from "./jev-guard.ts";

const s = (over: Partial<GuardScores> = {}): GuardScores => ({ risk: 0, approval: 0, userRequested: 0, fromUntrusted: 0, ...over });

describe("decide", () => {
  it.each([
    ["from_untrusted just under 0.7 passes", s({ fromUntrusted: 0.69 }), "allow"],
    ["from_untrusted at 0.7 is denied", s({ fromUntrusted: 0.7 }), "deny"],
    ["from_untrusted beats a user request", s({ fromUntrusted: 0.7, userRequested: 1 }), "deny"],
    ["risk just under 1.5 and approval just under 0.75 pass", s({ risk: 1.49, approval: 0.74 }), "allow"],
    ["risk at 1.5 asks", s({ risk: 1.5 }), "ask"],
    ["approval at 0.75 asks", s({ approval: 0.75 }), "ask"],
    ["risk at 1.5 with user_requested just under 0.85 asks", s({ risk: 1.5, userRequested: 0.84 }), "ask"],
    ["risk at 1.5 with user_requested at 0.85 allows", s({ risk: 1.5, userRequested: 0.85 }), "allow"],
    ["approval at 0.75 with user_requested at 0.85 allows", s({ approval: 0.9, userRequested: 0.85 }), "allow"],
    ["risk just under 2.5 with a user request allows", s({ risk: 2.49, userRequested: 1 }), "allow"],
    ["risk at 2.5 is denied", s({ risk: 2.5 }), "deny"],
    ["risk at 2.5 is denied even when asked for", s({ risk: 2.5, userRequested: 1 }), "deny"],
    ["risk 3 is denied", s({ risk: 3 }), "deny"],
  ])("%s", (_name, scores, level) => {
    expect(decide(scores).level).toBe(level);
  });

  it("gives a reason only for deny and a user request", () => {
    expect(decide(s({ risk: 3 })).why).toBeTruthy();
    expect(decide(s()).why).toBeUndefined();
  });
});

describe("approvingOption", () => {
  it.each([
    [["Yes, run it", "No, wait"], "Yes, run it"],
    [["Continue", "Cancel"], "Continue"],
    [["Approve", "Deny"], "Approve"],
    [["Allow", "Skip"], "Allow"],
    [["Yes, approve once", "No, skip this file"], "Yes, approve once"],
    [["Yes, once", "Yes, always", "No"], null],
    [["Postgres", "SQLite"], null],
    [["No", "Not now"], null],
    [["Yes, but do not delete anything", "No"], null],
  ])("%j -> %s", (labels, expected) => {
    expect(approvingOption(labels)).toBe(expected);
  });
});

describe("buildGuardState", () => {
  const key = "sk-test-ABCDEFGHIJKLMNOPQRSTUVWX";
  it("redacts keys and cuts the first prompt at 700 characters and the calls to six", () => {
    const state = buildGuardState(
      { agentId: "a", agentTitle: "Build", tool: "Bash", input: `curl -H "Authorization: Bearer ${key}" x`, cwd: "/w" },
      { firstPrompt: "p".repeat(900), recent: Array.from({ length: 9 }, (_, i) => `call ${i} ${key}`) },
    );
    expect(JSON.stringify(state)).not.toContain(key);
    expect(state.context?.first_prompt).toHaveLength(700);
    expect(state.context?.recent_tool_calls).toHaveLength(6);
    expect(state.context?.recent_tool_calls[0]).toContain("call 3");
  });

  it("leaves the context out when there is none", () => {
    expect(buildGuardState({ agentId: "a", agentTitle: "t", tool: "Bash", input: "ls", cwd: "/w" }, null)).not.toHaveProperty("context");
  });
});

describe("the questions", () => {
  it("say that reading secrets here is normal and that sending them out is the risk", () => {
    expect(GUARD_QUESTIONS.risk.instructions).toMatch(/including secrets/);
    expect(GUARD_QUESTIONS.risk.instructions).toMatch(/off this machine/);
    expect(GUARD_QUESTIONS.risk.levels).toHaveLength(4);
  });
});

describe("createJevGuard", () => {
  const request = { agentId: "a1", agentTitle: "Build", tool: "Bash", input: "ls", cwd: "/w" };
  const answers = (risk: number) => ({
    ok: true as const, provider: "jev" as const, latencyMs: 1,
    answers: { risk: { type: "score", score: risk, level: 0, probabilities: [] }, approval: { type: "yesno", p: 0 }, user_requested: { type: "yesno", p: 0 }, from_untrusted: { type: "yesno", p: 0 } },
  });

  it("keeps the context of an agent for a short while", async () => {
    let clock = 0;
    const agentContext = vi.fn(async () => ({ recent: ["x"] }));
    const ask = vi.fn(async () => answers(0));
    const guard = createJevGuard({ decider: { ask: ask as never }, agentContext, log: () => {}, now: () => clock });
    await guard.assess(request);
    await guard.assess(request);
    expect(agentContext).toHaveBeenCalledTimes(1);
    clock += 16_000;
    await guard.assess(request);
    expect(agentContext).toHaveBeenCalledTimes(2);
  });

  it("does not wait longer than a second for the context, and still asks Jev", async () => {
    vi.useFakeTimers();
    try {
      const ask = vi.fn(async () => answers(0));
      const guard = createJevGuard({ decider: { ask: ask as never }, agentContext: () => new Promise(() => {}), log: () => {} });
      const pending = guard.assess(request);
      await vi.advanceTimersByTimeAsync(1_100);
      expect((await pending).level).toBe("allow");
      const timeout = (ask.mock.calls[0] as unknown as [string, unknown, unknown, { timeoutMs: number }])[3].timeoutMs;
      expect(timeout).toBeLessThanOrEqual(2_000);
      expect(timeout).toBeGreaterThanOrEqual(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns ask, with no scores, when Jev fails or throws", async () => {
    const logs: string[] = [];
    const failing = createJevGuard({ decider: { ask: (async () => ({ ok: false, provider: "jev", reason: "timeout" })) as never }, log: (m) => logs.push(m) });
    expect(await failing.assess(request)).toEqual({ level: "ask" });
    const throwing = createJevGuard({ decider: { ask: (async () => { throw new Error("boom"); }) as never }, log: (m) => logs.push(m) });
    expect(await throwing.assess(request)).toEqual({ level: "ask" });
    expect(logs.join("\n")).not.toContain("ls");
  });
});

describe("scoresLine", () => {
  it("lists the four scores", () => {
    expect(scoresLine(s({ risk: 1.25, approval: 0.5, userRequested: 0.9, fromUntrusted: 0.01 }))).toBe("risk 1.3/3, approval 0.50, user_requested 0.90, from_untrusted 0.01");
  });
});
