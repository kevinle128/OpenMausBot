import { describe, expect, it } from "vitest";

import { formatAutoApproval, type AutoApproval } from "./auto-approval.ts";

const entry: AutoApproval = { key: "k", agent: "Fix the app", workspace: "/work/app", what: "rm -rf dist", rule: "jev-guard" };

describe("history line text", () => {
  it("names OpenMausBot and the rule for what was allowed without asking, with the count of repeats", () => {
    expect(formatAutoApproval(entry, 2).split("\n")).toEqual(["✓ OpenMausBot tự duyệt (2 lần)", "Agent: Fix the app", "Workspace: /work/app", "Việc: rm -rf dist", "Luật: jev-guard"]);
  });

  it("names the person's answer and no rule for a card the person answered", () => {
    expect(formatAutoApproval({ ...entry, rule: "person", answer: { decision: "allow" } }, 1).split("\n")).toEqual(["✓ Bạn đã duyệt", "Agent: Fix the app", "Workspace: /work/app", "Việc: rm -rf dist"]);
    expect(formatAutoApproval({ ...entry, rule: "person", answer: { decision: "deny" } }, 1).split("\n")[0]).toBe("✗ Bạn đã từ chối");
    expect(formatAutoApproval({ ...entry, rule: "person", answer: { choice: "SQLite" } }, 1).split("\n")[0]).toBe("✓ Bạn đã chọn: SQLite");
  });
});
