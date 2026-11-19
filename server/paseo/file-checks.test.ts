import { describe, expect, it, vi } from "vitest";

import type { PaseoPathInspection } from "./connection.ts";
import { classifyPermission, type PathInspector, type PermissionContext } from "./permission-rules.ts";
import { APPROVE_ONCE, hookReadQuestion } from "./question-rules.ts";

const CWD = "/agent/work";
const answer = (kind: PaseoPathInspection["kind"], exists = kind !== null): PaseoPathInspection => ({ exists, kind, size: exists ? 4 : null, error: null });

/** How the daemon on the agent's machine can answer, or fail to. */
const outcomes: Record<string, () => Promise<PaseoPathInspection>> = {
  missing: async () => answer(null, false),
  directory: async () => answer("directory"),
  symlink: async () => answer("symlink"),
  other: async () => answer("other"),
  "daemon error": async () => ({ ...answer(null, false), error: "Access outside of workspace is not allowed" }),
  "daemon timeout": () => Promise.reject(new Error("The Paseo daemon did not answer a path inspection")),
  "daemon that does not know the request": () => Promise.reject(new Error("The Paseo client cannot inspect a path")),
};

/** Literal names (those with the `APPROVED:` prefix) are missing; every other path gets the outcome. */
const inspector = (outcome: () => Promise<PaseoPathInspection>): PathInspector =>
  vi.fn(async (_cwd: string, path: string) => (path.startsWith("APPROVED:") ? answer(null, false) : outcome()));
const context = (outcome: () => Promise<PaseoPathInspection>): PermissionContext => ({ cwd: CWD, inspectPath: inspector(outcome), gitConfigSafe: () => true });

const shell = (command: string) => ({ kind: "tool" as const, name: "Bash", detail: { type: "shell" as const, command } });
const read = (filePath: string) => ({ kind: "tool" as const, name: "Read", detail: { type: "read" as const, filePath } });
const hookQuestion = (filePath: string) => ({
  kind: "question" as const,
  name: "AskUserQuestion",
  input: {
    questions: [
      {
        header: "File Access",
        multiSelect: false,
        options: [{ label: APPROVE_ONCE }, { label: "No, skip this file" }],
        question: `I need to read "${filePath.split("/").pop()}" (${filePath}), which may contain sensitive data (API keys, passwords, tokens). Do you approve this one time?`,
      },
    ],
  },
});

const RULES = {
  envCommand: "env-file-read-command",
  envRead: "env-file-read",
  approved: "approved-file-read-command",
};

describe("file checks on the agent's machine", () => {
  describe("a regular file", () => {
    const plainFile = context(async () => answer("file"));

    it("lets an env file read go", async () => {
      expect(await classifyPermission(read(".env"), plainFile)).toEqual({ verdict: "allow", rule: RULES.envRead });
      expect((await classifyPermission(shell("cat .env"), plainFile)).rule).toBe(RULES.envCommand);
    });

    it("lets a file the person approved once go", async () => {
      expect((await classifyPermission(shell("cat APPROVED:keys/server.pem"), plainFile)).rule).toBe(RULES.approved);
    });

    it("lets the hook's read question be answered without the person", async () => {
      expect(await hookReadQuestion(hookQuestion("/agent/work/server.pem"), plainFile)).toEqual({
        filePath: "/agent/work/server.pem",
        question: expect.stringContaining("server.pem"),
      });
    });

    it("asks the daemon about the path as written, with the agent's directory, and nothing else", async () => {
      const inspectPath = vi.fn(async () => answer("file"));
      await classifyPermission(read(".env"), { cwd: CWD, inspectPath });
      expect(inspectPath).toHaveBeenCalledTimes(1);
      expect(inspectPath).toHaveBeenCalledWith(CWD, ".env");
    });
  });

  describe.each(Object.entries(outcomes))("when the daemon reports: %s", (_name, outcome) => {
    const ctx = () => context(outcome);

    it("does not allow an env file read", async () => {
      expect(await classifyPermission(read(".env"), ctx())).toEqual({ verdict: "ask", rule: "other-file", hazard: true });
      expect((await classifyPermission(shell("cat .env"), ctx())).rule).not.toBe(RULES.envCommand);
    });

    it("does not allow a file the person approved once", async () => {
      expect((await classifyPermission(shell("cat APPROVED:keys/server.pem"), ctx())).rule).not.toBe(RULES.approved);
    });

    it("does not answer the hook's read question", async () => {
      expect(await hookReadQuestion(hookQuestion("/agent/work/server.pem"), ctx())).toBeNull();
    });
  });

  describe("when the file checks cannot be made at all", () => {
    it("allows nothing without an inspector", async () => {
      const bare: PermissionContext = { cwd: CWD };
      expect(await classifyPermission(read(".env"), bare)).toEqual({ verdict: "ask", rule: "other-file", hazard: true });
      expect((await classifyPermission(shell("cat .env"), bare)).rule).not.toBe(RULES.envCommand);
      expect((await classifyPermission(shell("cat APPROVED:a.pem"), bare)).rule).not.toBe(RULES.approved);
      expect(await hookReadQuestion(hookQuestion("/agent/work/a.pem"), bare)).toBeNull();
    });

    it("allows nothing without the agent's directory, and does not ask the daemon", async () => {
      const inspectPath = vi.fn(async () => answer("file"));
      const noCwd: PermissionContext = { inspectPath };
      expect(await classifyPermission(read("/agent/work/.env"), noCwd)).toEqual({ verdict: "ask", rule: "other-file", hazard: true });
      expect(await hookReadQuestion(hookQuestion("/agent/work/a.pem"), noCwd)).toBeNull();
      expect(inspectPath).not.toHaveBeenCalled();
    });
  });

  it("treats an APPROVED: argument that cannot be looked up as a hidden hazard for the person alone", async () => {
    const literal: PathInspector = async () => {
      throw new Error("The Paseo daemon did not answer a path inspection");
    };
    const decision = await classifyPermission(shell("cat APPROVED:keys/server.pem"), { cwd: CWD, inspectPath: literal, gitConfigSafe: () => true });
    expect(decision).toMatchObject({ verdict: "ask", hazard: true });
  });

  it("treats a file really named with the prefix as a hidden hazard", async () => {
    const named: PathInspector = async () => answer("file");
    const decision = await classifyPermission(shell("cat APPROVED:keys/server.pem"), { cwd: CWD, inspectPath: named, gitConfigSafe: () => true });
    expect(decision).toMatchObject({ verdict: "ask", hazard: true });
  });
});
