import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT, HARNESSES, main, SKILL_TEXT, type Deps } from "../../bin/omb.mjs";
import { memoryOutput } from "../testing/omb-cli-kit.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const posix = process.platform !== "win32";
const SKILL_FILE = new URL("../../skills/omb-vault/SKILL.md", import.meta.url);
const NODE = "/opt/node/bin/node";
const OMB = "/opt/omb/bin/omb.mjs";
const HOOK = `"${NODE}" "${OMB}" hook claude-pretooluse`;
const placeholder = (name: string) => ["$", "{", "secret:", name, "}"].join("");

interface Row { harness: string; label: string; folder: string | null; status: string; recognised: boolean; note?: string }

let home = "";
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "omb-skill-")); });
afterEach(async () => { await removeTempDir(home); });

async function run(argv: string[], overrides: Partial<Deps> = {}, stdin = "") {
  const out = memoryOutput();
  const err = memoryOutput();
  const code = await main(argv, {
    env: {}, home, platform: "linux", ppid: 1, nodePath: NODE, selfPath: OMB, stdin: Readable.from([Buffer.from(stdin)]), stdinIsTTY: false,
    stdout: out.stream, stderr: err.stream, cwd: () => home, ...overrides,
  });
  return { code, out: out.text(), err: err.text() };
}

async function rowsOf(argv: string[], overrides: Partial<Deps> = {}) {
  const result = await run([...argv, "--json"], overrides);
  const parsed = JSON.parse(result.out);
  return { ...result, parsed, rows: parsed.data.rows as Row[] };
}

const rowFor = (rows: Row[], id: string) => rows.find((row) => row.harness === id)!;
const skillAt = (folder: string) => join(folder, "omb-vault", "SKILL.md");
const settingsIn = (dir: string) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

describe("embedded skill text", () => {
  it("is byte-equal to skills/omb-vault/SKILL.md", () => {
    expect(Buffer.from(SKILL_TEXT, "utf8").equals(readFileSync(SKILL_FILE))).toBe(true);
  });

  it("holds no whole secret placeholder, so the guard hook does not deny an edit of omb.mjs", () => {
    expect(SKILL_TEXT).not.toMatch(/\$\{secret:[A-Za-z0-9]/);
  });
});

describe("skill list", () => {
  it("lists every harness with its folder, status and whether omb can recognise the agent", async () => {
    const { code, parsed, rows } = await rowsOf(["skill", "list"]);
    expect(code).toBe(EXIT.done);
    expect(parsed).toMatchObject({ schema_version: 1, kind: "skill.list" });
    expect(rows.map((row) => row.harness)).toEqual(HARNESSES.map((harness) => harness.id));
    expect(rowFor(rows, "claudeAgent")).toEqual({ harness: "claudeAgent", label: "Claude", folder: join(home, ".claude", "skills"), status: "missing", recognised: true });
    expect(rowFor(rows, "codex")).toMatchObject({ folder: join(home, ".agents", "skills"), recognised: true });
    expect(rows.filter((row) => !row.recognised).map((row) => row.harness)).toEqual(["deepseekAgent"]);
    expect(rows.filter((row) => row.folder !== null).every((row) => row.recognised && row.note === undefined)).toBe(true);
    expect(rowFor(rows, "deepseekAgent")).toMatchObject({ folder: null, status: "unsupported", recognised: false, note: expect.stringContaining("no literal skill folder") });
    expect(rows.every((row) => row.status === "missing" || row.status === "unsupported")).toBe(true);
  });

  it("reports installed and outdated, and prints one text line per harness", async () => {
    await run(["skill", "install", "--harness", "codex"]);
    writeFileSync(skillAt(join(home, ".agents", "skills")), "old text");
    await run(["skill", "install", "--harness", "piAgent"]);
    const { rows } = await rowsOf(["skill", "list"]);
    expect(rowFor(rows, "codex").status).toBe("outdated");
    expect(rowFor(rows, "devinAgent").status).toBe("outdated");
    expect(rowFor(rows, "piAgent").status).toBe("installed");
    const text = await run(["skill", "list"]);
    expect(text.out.trim().split("\n")).toHaveLength(HARNESSES.length);
    expect(text.out).toContain(`piAgent  installed  ${join(home, ".pi", "agent", "skills")}`);
  });

  it("answers exit 2 for a stray argument and for an unknown skill command", async () => {
    expect((await run(["skill", "list", "codex"])).code).toBe(EXIT.invalid);
    expect((await run(["skill", "remove"])).code).toBe(EXIT.invalid);
    expect((await run(["skill", "list", "--nope"])).code).toBe(EXIT.invalid);
  });
});

describe("skill install", () => {
  it("writes the skill atomically with mode 0644 under folders of mode 0755", async () => {
    const { code, parsed, rows } = await rowsOf(["skill", "install", "--harness", "piAgent,cursorAgent"]);
    expect(code).toBe(EXIT.done);
    expect(parsed.kind).toBe("skill.install");
    expect(rows.map((row) => [row.harness, row.status])).toEqual([["piAgent", "installed"], ["cursorAgent", "installed"]]);
    const file = skillAt(join(home, ".pi", "agent", "skills"));
    expect(readFileSync(file, "utf8")).toBe(SKILL_TEXT);
    expect(readdirSync(join(home, ".pi", "agent", "skills", "omb-vault"))).toEqual(["SKILL.md"]);
    expect(readFileSync(skillAt(join(home, ".cursor", "skills")), "utf8")).toBe(SKILL_TEXT);
    if (posix) {
      expect(lstatSync(file).mode & 0o777).toBe(0o644);
      expect(lstatSync(join(home, ".pi", "agent", "skills", "omb-vault")).mode & 0o777).toBe(0o755 & ~process.umask());
    }
  });

  it("installs for all harnesses, skips DeepSeek with a reason and leaves other keys of the home alone", async () => {
    const { code, rows } = await rowsOf(["skill", "install", "--all"]);
    expect(code).toBe(EXIT.done);
    expect(rows).toHaveLength(HARNESSES.length);
    expect(rowFor(rows, "deepseekAgent")).toMatchObject({ status: "skipped", folder: null, note: expect.stringContaining("no literal skill folder") });
    for (const row of rows.filter((one) => one.folder)) {
      expect(["installed", "unchanged"]).toContain(row.status);
      expect(readFileSync(skillAt(row.folder!), "utf8")).toBe(SKILL_TEXT);
    }
    expect(rowFor(rows, "geminiAgent").note).toBeUndefined();
    expect(rowFor(rows, "codex").note).toBeUndefined();
  });

  it("answers unchanged on a second run, and updated after the content changed", async () => {
    await run(["skill", "install", "--harness", "grokAgent"]);
    const again = await rowsOf(["skill", "install", "--harness", "grokAgent"]);
    expect(rowFor(again.rows, "grokAgent").status).toBe("unchanged");
    writeFileSync(skillAt(join(home, ".grok", "skills")), `${SKILL_TEXT}\nlocal edit\n`);
    const updated = await rowsOf(["skill", "install", "--harness", "grokAgent"]);
    expect(rowFor(updated.rows, "grokAgent").status).toBe("updated");
    expect(readFileSync(skillAt(join(home, ".grok", "skills")), "utf8")).toBe(SKILL_TEXT);
  });

  it("writes a shared folder once and reports each harness", async () => {
    const { rows } = await rowsOf(["skill", "install", "--harness", "codex,devinAgent"]);
    expect(rows.map((row) => [row.harness, row.status, row.folder])).toEqual([
      ["codex", "installed", join(home, ".agents", "skills")],
      ["devinAgent", "installed", join(home, ".agents", "skills")],
    ]);
    expect(readdirSync(join(home, ".agents", "skills"))).toEqual(["omb-vault"]);
  });

  it("accepts --harness more than once and ignores duplicates", async () => {
    const { rows } = await rowsOf(["skill", "install", "--harness", "codex", "--harness", "codex,kiroAgent"]);
    expect(rows.map((row) => row.harness)).toEqual(["codex", "kiroAgent"]);
  });

  it("answers exit 2 for an unknown id and writes nothing", async () => {
    const result = await run(["skill", "install", "--harness", "codex,nopeAgent", "--json"]);
    expect(result.code).toBe(EXIT.invalid);
    expect(JSON.parse(result.out)).toMatchObject({ schema_version: 1, error_code: "invalid_request", exit_code: 2 });
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  it("answers exit 2 when neither or both of --harness and --all are given", async () => {
    expect((await run(["skill", "install"])).code).toBe(EXIT.invalid);
    expect((await run(["skill", "install", "--all", "--harness", "codex"])).code).toBe(EXIT.invalid);
    expect((await run(["skill", "install", "--harness", ""])).code).toBe(EXIT.invalid);
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  it("needs no pairing and no agent above the process", async () => {
    const result = await run(["skill", "install", "--harness", "codex"], { ppid: 999_999_999 });
    expect(result.code).toBe(EXIT.done);
  });

  it("honours the variables that move a skill folder, and ignores a relative value", async () => {
    const moved = join(home, "moved");
    const env = {
      CLAUDE_CONFIG_DIR: join(moved, "claude"), PI_CODING_AGENT_DIR: join(moved, "pi"), COPILOT_HOME: join(moved, "copilot"), QWEN_HOME: join(moved, "qwen"),
      KIMI_CODE_HOME: join(moved, "kimi"), CLINE_DIR: join(moved, "cline"), HERMES_HOME: join(moved, "hermes"), VIBE_HOME: join(moved, "vibe"),
      XDG_CONFIG_HOME: join(moved, "xdg"), CODEX_HOME: join(moved, "codex"), KIRO_HOME: join(moved, "kiro"),
    };
    const { rows } = await rowsOf(["skill", "install", "--all"], { env });
    const folder = (id: string) => rowFor(rows, id).folder;
    expect(folder("claudeAgent")).toBe(join(moved, "claude", "skills"));
    expect(folder("piAgent")).toBe(join(moved, "pi", "skills"));
    expect(folder("copilotAgent")).toBe(join(moved, "copilot", "skills"));
    expect(folder("qwenAgent")).toBe(join(moved, "qwen", "skills"));
    expect(folder("kimiAgent")).toBe(join(moved, "kimi", "skills"));
    expect(folder("clineAgent")).toBe(join(moved, "cline", "skills"));
    expect(folder("hermesAgent")).toBe(join(moved, "hermes", "skills"));
    expect(folder("mistralVibeAgent")).toBe(join(moved, "vibe", "skills"));
    expect(folder("museCode")).toBe(join(moved, "xdg", "muse", "skills"));
    expect(folder("codex")).toBe(join(home, ".agents", "skills"));
    expect(folder("kiroAgent")).toBe(join(home, ".kiro", "skills"));
    expect(existsSync(join(home, ".claude"))).toBe(false);
    const relative = await rowsOf(["skill", "list"], { env: { CLAUDE_CONFIG_DIR: "relative/claude" } });
    expect(rowFor(relative.rows, "claudeAgent").folder).toBe(join(home, ".claude", "skills"));
  });

  it.runIf(posix)("refuses a symbolic link as the skill folder or file, and exits 6 without writing through it", async () => {
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    const grokSkills = join(home, ".grok", "skills");
    mkdirSync(grokSkills, { recursive: true });
    symlinkSync(elsewhere, join(grokSkills, "omb-vault"));
    const kiroDir = join(home, ".kiro", "skills", "omb-vault");
    mkdirSync(kiroDir, { recursive: true });
    const target = join(home, "target.md");
    writeFileSync(target, "keep me");
    symlinkSync(target, join(kiroDir, "SKILL.md"));
    const { code, rows } = await rowsOf(["skill", "install", "--harness", "grokAgent,kiroAgent,codex"]);
    expect(code).toBe(EXIT.refused);
    expect(rowFor(rows, "grokAgent")).toMatchObject({ status: "refused", note: expect.stringContaining("symbolic link") });
    expect(rowFor(rows, "kiroAgent")).toMatchObject({ status: "refused", note: expect.stringContaining("symbolic link") });
    expect(rowFor(rows, "codex").status).toBe("installed");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readFileSync(target, "utf8")).toBe("keep me");
    expect(rowFor((await rowsOf(["skill", "list"])).rows, "grokAgent").status).toBe("refused");
  });

  it.runIf(posix)("exits 5 when a write fails and still installs the other folders", async () => {
    writeFileSync(join(home, ".cursor"), "a file where a folder should be");
    const { code, rows } = await rowsOf(["skill", "install", "--harness", "cursorAgent,codex"]);
    expect(code).toBe(EXIT.unreachable);
    expect(rowFor(rows, "cursorAgent")).toMatchObject({ status: "failed", note: expect.stringContaining("cannot write") });
    expect(rowFor(rows, "codex").status).toBe("installed");
  });

  it("leaves no temporary file behind", async () => {
    await run(["skill", "install", "--all"]);
    const leftovers = [".agents", ".gemini", ".kiro"].flatMap((dir) => readdirSync(join(home, dir, "skills", "omb-vault")));
    expect(leftovers.every((name) => name === "SKILL.md")).toBe(true);
  });
});

describe("Claude Code guard hook entry", () => {
  const claudeDir = () => join(home, ".claude");

  it("adds the hook with absolute paths when the Claude row is installed", async () => {
    const { code, rows } = await rowsOf(["skill", "install", "--harness", "claudeAgent"]);
    expect(code).toBe(EXIT.done);
    expect(rowFor(rows, "claudeAgent").note).toContain("guard hook was added");
    expect(settingsIn(claudeDir())).toEqual({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: HOOK }] }] } });
    if (posix) expect(lstatSync(join(claudeDir(), "settings.json")).mode & 0o777).toBe(0o600);
  });

  it("does not touch Claude settings when Claude is not selected", async () => {
    await run(["skill", "install", "--harness", "codex"]);
    expect(existsSync(claudeDir())).toBe(false);
  });

  it("is idempotent: a second run keeps one entry and does not rewrite the file", async () => {
    await run(["skill", "install", "--harness", "claudeAgent"]);
    const before = readFileSync(join(claudeDir(), "settings.json"), "utf8");
    const again = await rowsOf(["skill", "install", "--harness", "claudeAgent"]);
    expect(rowFor(again.rows, "claudeAgent").note).toContain("already in");
    expect(readFileSync(join(claudeDir(), "settings.json"), "utf8")).toBe(before);
  });

  it("keeps every other key and hook, and updates the path of an older omb entry", async () => {
    mkdirSync(claudeDir(), { recursive: true });
    const other = { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/audit-bash" }] };
    const stale = { matcher: "*", hooks: [{ type: "command", command: '"/old/node" "/old/omb/bin/omb.mjs" hook claude-pretooluse', timeout: 5 }, { type: "command", command: "/usr/local/bin/also-mine" }] };
    const original = { model: "opus", permissions: { allow: ["Bash(ls:*)"] }, hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "/bin/true" }] }], PreToolUse: [other, stale] } };
    writeFileSync(join(claudeDir(), "settings.json"), JSON.stringify(original));
    const { rows } = await rowsOf(["skill", "install", "--harness", "claudeAgent"]);
    expect(rowFor(rows, "claudeAgent").note).toContain("guard hook was updated");
    const merged = settingsIn(claudeDir());
    expect(merged.model).toBe("opus");
    expect(merged.permissions).toEqual(original.permissions);
    expect(merged.hooks.PostToolUse).toEqual(original.hooks.PostToolUse);
    expect(merged.hooks.PreToolUse).toEqual([
      other,
      { matcher: "*", hooks: [{ type: "command", command: HOOK, timeout: 5 }, { type: "command", command: "/usr/local/bin/also-mine" }] },
    ]);
  });

  it("removes a duplicate omb entry and drops an entry it leaves empty", async () => {
    mkdirSync(claudeDir(), { recursive: true });
    const entry = (path: string) => ({ matcher: "*", hooks: [{ type: "command", command: `"/n/node" "${path}" hook claude-pretooluse` }] });
    writeFileSync(join(claudeDir(), "settings.json"), JSON.stringify({ hooks: { PreToolUse: [entry("/a/omb"), entry("/b/omb.mjs")] } }));
    await run(["skill", "install", "--harness", "claudeAgent"]);
    expect(settingsIn(claudeDir()).hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: HOOK }] }]);
  });

  it("leaves a settings file that is not valid JSON untouched and says so", async () => {
    mkdirSync(claudeDir(), { recursive: true });
    writeFileSync(join(claudeDir(), "settings.json"), "{ not json");
    const { code, rows } = await rowsOf(["skill", "install", "--harness", "claudeAgent"]);
    expect(code).toBe(EXIT.done);
    expect(readFileSync(join(claudeDir(), "settings.json"), "utf8")).toBe("{ not json");
    expect(rowFor(rows, "claudeAgent")).toMatchObject({ status: "installed", note: expect.stringContaining("is not valid JSON") });
    expect(readFileSync(skillAt(join(claudeDir(), "skills")), "utf8")).toBe(SKILL_TEXT);
  });

  it("leaves hooks of an unexpected shape untouched", async () => {
    mkdirSync(claudeDir(), { recursive: true });
    const text = JSON.stringify({ hooks: { PreToolUse: "no" } });
    writeFileSync(join(claudeDir(), "settings.json"), text);
    const { rows } = await rowsOf(["skill", "install", "--harness", "claudeAgent"]);
    expect(readFileSync(join(claudeDir(), "settings.json"), "utf8")).toBe(text);
    expect(rowFor(rows, "claudeAgent").note).toContain("shape omb does not edit");
  });

  it.runIf(posix)("writes through a symbolic link to the settings file and keeps its mode", async () => {
    mkdirSync(claudeDir(), { recursive: true });
    const real = join(home, "dotfiles-settings.json");
    writeFileSync(real, JSON.stringify({ model: "opus" }));
    chmodSync(real, 0o640);
    symlinkSync(real, join(claudeDir(), "settings.json"));
    await run(["skill", "install", "--harness", "claudeAgent"]);
    expect(lstatSync(join(claudeDir(), "settings.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toMatchObject({ model: "opus", hooks: { PreToolUse: [{ matcher: "*" }] } });
    expect(lstatSync(real).mode & 0o777).toBe(0o640);
  });

  it("uses CLAUDE_CONFIG_DIR for both the skill and the settings file", async () => {
    const moved = join(home, "moved-claude");
    await run(["skill", "install", "--harness", "claudeAgent"], { env: { CLAUDE_CONFIG_DIR: moved } });
    expect(existsSync(skillAt(join(moved, "skills")))).toBe(true);
    expect(settingsIn(moved).hooks.PreToolUse).toHaveLength(1);
    expect(existsSync(claudeDir())).toBe(false);
  });

  it("does not add a hook whose path it cannot quote", async () => {
    const { rows } = await rowsOf(["skill", "install", "--harness", "claudeAgent"], { selfPath: '/odd/"omb.mjs' });
    expect(rowFor(rows, "claudeAgent").note).toContain("cannot quote");
    expect(existsSync(join(claudeDir(), "settings.json"))).toBe(false);
  });
});

describe("hook claude-pretooluse", () => {
  const event = (toolInput: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: toolInput });

  it("denies a placeholder anywhere in the tool input, names the commands to use and shows only the ref names", async () => {
    const result = await run(["hook", "claude-pretooluse"], {}, event({ command: `curl -H "Authorization: Bearer ${placeholder("GITHUB_TOKEN")}" https://api.github.com`, nested: { list: ["x", `a ${placeholder("DB_PASS")} b`] } }));
    expect(result.code).toBe(EXIT.done);
    const decision = JSON.parse(result.out);
    expect(decision.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    const reason: string = decision.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("omb secrets fetch");
    expect(reason).toContain("omb secrets run");
    expect(reason).toContain("omb-vault");
    expect(reason).toContain("GITHUB_TOKEN, DB_PASS");
    expect(reason).not.toContain("api.github.com");
    expect(reason).not.toMatch(/\$\{/);
    expect(result.err).toBe("");
  });

  it("denies a placeholder that carries options after the name", async () => {
    const result = await run(["hook", "claude-pretooluse"], {}, event({ content: `x=${["$", "{", "secret:", "API_KEY", ":raw", "}"].join("")}` }));
    expect(JSON.parse(result.out).hookSpecificOutput.permissionDecisionReason).toContain("API_KEY");
  });

  it("keeps a match inside one placeholder: an unclosed example neither spans lines nor swallows a later placeholder", async () => {
    const open = ["$", "{", "secret:"].join("");
    const prose = await run(["hook", "claude-pretooluse"], {}, event({ content: `see \`${open}EXAMPLE\`\nconst x = { a: 1 };` }));
    expect(prose).toEqual({ code: EXIT.done, out: "", err: "" });
    const both = await run(["hook", "claude-pretooluse"], {}, event({ content: `\`${open}EXAMPLE\` then ${placeholder("REAL_TOKEN")}` }));
    expect(JSON.parse(both.out).hookSpecificOutput.permissionDecisionReason).toContain("Names found: REAL_TOKEN.");
  });

  it("stays fast on many unclosed placeholders and names at most 10 refs", async () => {
    const open = ["$", "{", "secret:"].join("");
    const started = Date.now();
    expect(await run(["hook", "claude-pretooluse"], {}, event({ command: `${open}ABCDEFGH `.repeat(20000) }))).toEqual({ code: EXIT.done, out: "", err: "" });
    expect(Date.now() - started).toBeLessThan(2000);
    const many = Array.from({ length: 15 }, (_, i) => placeholder(`N${i}`)).join(" ");
    const reason: string = JSON.parse((await run(["hook", "claude-pretooluse"], {}, event({ command: many }))).out).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("N9.");
    expect(reason).not.toContain("N10");
  });

  it("prints nothing and exits 0 for an ordinary tool call", async () => {
    for (const input of [event({ command: "ls -la" }), event({ command: "echo '${HOME}' ${secret_not_a_ref} secret:NAME" }), event(undefined), JSON.stringify({ tool_name: "Read" })]) {
      expect(await run(["hook", "claude-pretooluse"], {}, input)).toEqual({ code: EXIT.done, out: "", err: "" });
    }
  });

  it("prints nothing for another hook event", async () => {
    const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_input: { command: placeholder("X") } });
    expect(await run(["hook", "claude-pretooluse"], {}, input)).toEqual({ code: EXIT.done, out: "", err: "" });
  });

  it("allows the call when stdin is empty, not JSON, or a terminal", async () => {
    expect(await run(["hook", "claude-pretooluse"], {}, "")).toEqual({ code: EXIT.done, out: "", err: "" });
    expect(await run(["hook", "claude-pretooluse"], {}, "{ nope")).toEqual({ code: EXIT.done, out: "", err: "" });
    expect(await run(["hook", "claude-pretooluse"], { stdinIsTTY: true }, event({ command: placeholder("X") }))).toEqual({ code: EXIT.done, out: "", err: "" });
  });

  it("answers exit 2 for an unknown hook name", async () => {
    expect((await run(["hook", "other"])).code).toBe(EXIT.invalid);
    expect((await run(["hook"])).code).toBe(EXIT.invalid);
  });
});
