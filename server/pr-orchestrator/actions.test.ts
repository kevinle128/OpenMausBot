import { describe, expect, it } from "vitest";
import { ACTION_REGISTRY, actionTypesForEditor, checkAction } from "./actions.ts";
import { ACTION_TYPES, COMMAND_TYPES } from "./types.ts";

describe("action registry", () => {
  it("has a registry entry for every action type", () => {
    for (const type of ACTION_TYPES) {
      expect(ACTION_REGISTRY[type].type).toBe(type);
      expect(COMMAND_TYPES).toContain(ACTION_REGISTRY[type].command);
    }
    expect(actionTypesForEditor().map(entry => entry.type)).toEqual([...ACTION_TYPES]);
    expect(ACTION_REGISTRY.Instruct.command).toBe("RunInstruction");
  });

  it("refuses unknown params and an ask kind only the core may raise", () => {
    expect(checkAction({ do: "Merge" })).toEqual({ ok: true, params: {} });
    expect(checkAction({ do: "Merge", params: { force: true } }).ok).toBe(false);
    expect(checkAction({ do: "AskPerson", params: { kind: "decision" } }).ok).toBe(true);
    const gated = checkAction({ do: "AskPerson", params: { kind: "approve_action" } });
    expect(gated.ok).toBe(false);
    expect(checkAction({ do: "TellOwner", params: { template: "nope" } }).ok).toBe(false);
    expect(checkAction({ do: "TellOwner" }).ok).toBe(false);
    expect(checkAction({ do: "Nothing" as never }).ok).toBe(false);
  });

  it("accepts a config reference for a param and keeps it", () => {
    const params = { workflow: { config: "workflows.ciFix.workflow" }, message: { config: "workflows.ciFix.message" }, connection: { config: "workflows.ciFix.connection" } };
    expect(checkAction({ do: "RunWorkflow", params })).toEqual({ ok: true, params });
    expect(checkAction({ do: "RunWorkflow", params: { workflow: "ci-fix", message: "CI failed on {{repo}}", connection: null } }).ok).toBe(true);
    expect(checkAction({ do: "RunWorkflow", params: { workflow: "", message: "x" } }).ok).toBe(false);
  });

  it("refuses an instruction prompt with an unknown placeholder", () => {
    const refused = checkAction({ do: "Instruct", params: { to: "owner", prompt: "Fix {{nope}}" } });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.error).toContain("unknown placeholder nope");
    expect(checkAction({ do: "Instruct", params: { to: "owner", prompt: "CI failed on {{repo}}#{{number}}: {{logTail}}" } }).ok).toBe(true);
    expect(checkAction({ do: "Instruct", params: { to: "someone", prompt: "x" } }).ok).toBe(false);
  });

  it("decides the subject of Instruct by its target", () => {
    expect(ACTION_REGISTRY.Instruct.subjects({ to: "owner" })).toBe("pr");
    expect(ACTION_REGISTRY.Instruct.subjects({ to: "new-agent" })).toBe("any");
    expect(ACTION_REGISTRY.RunWorkflow.guard?.({ workflow: "ci-fix" })).toBe("workflow:ci-fix");
  });

  it("describes each built-in action in one sentence", () => {
    const samples: Record<string, Record<string, string>> = {
      TellOwner: { template: "conflict" }, AskPerson: { kind: "decision" }, Notify: { kind: "merged" }, Merge: {}, RefreshDetails: {},
      RunWorkflow: { workflow: "ci-fix", message: "m" }, Instruct: { to: "owner", prompt: "p" },
    };
    for (const type of ACTION_TYPES) {
      const sentence = ACTION_REGISTRY[type].describe(samples[type]);
      expect(sentence.length).toBeGreaterThan(5);
      expect(sentence).not.toContain("\n");
    }
    expect(ACTION_REGISTRY.RunWorkflow.describe({ workflow: "ci-fix" })).toBe("run workflow ci-fix (one active run per PR)");
    expect(ACTION_REGISTRY.Instruct.describe({ to: "new-agent", prompt: "x" })).toBe("instruct a new agent");
    expect(ACTION_REGISTRY.Instruct.describe({ to: { config: "workflows.who" }, prompt: "x" })).toBe("instruct config workflows.who");
  });
});
