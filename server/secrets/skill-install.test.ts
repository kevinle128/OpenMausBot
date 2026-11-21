import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSkillInstaller } from "./skill-install.ts";

const OMB = fileURLToPath(new URL("../../bin/omb.mjs", import.meta.url));
let home: string;
let bin: string;

// A clean environment object: a stray CLAUDE_CONFIG_DIR or XDG_CONFIG_HOME of the machine must never steer a write.
const installer = (extra: { source?: string; platform?: NodeJS.Platform } = {}) => createSkillInstaller({ environment: { PATH: bin }, home, source: OMB, ...extra });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omb-skill-server-"));
  bin = join(home, "node-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "node"), "#!/bin/sh\n");
  chmodSync(join(bin, "node"), 0o755);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// omb supports macOS and Linux only: file modes, a shell `node` stand-in and symbolic links do not hold on Windows.
describe.skipIf(process.platform === "win32")("the skill installer of the server", () => {
  it("lists every harness with its state", async () => {
    const rows = await installer().list();
    expect(rows).toHaveLength(21);
    expect(rows.find((row) => row.harness === "codex")).toMatchObject({ status: "missing", recognised: true, folder: join(home, ".agents", "skills") });
    expect(rows.find((row) => row.harness === "deepseekAgent")?.status).toBe("unsupported");
  });

  it("copies omb to ~/.local/bin/omb, writes the skill, and points the Claude hook at that copy and the node of PATH", async () => {
    const done = await installer().install(["codex", "claudeAgent"]);
    expect(done.command).toBe(join(home, ".local", "bin", "omb"));
    expect(statSync(done.command).mode & 0o777).toBe(0o755);
    expect(done.rows.map((row) => [row.harness, row.status])).toEqual([["claudeAgent", "installed"], ["codex", "installed"]]);
    expect(existsSync(join(home, ".agents", "skills", "omb-vault", "SKILL.md"))).toBe(true);
    const hook = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command as string;
    expect(hook).toBe(`"${join(bin, "node")}" "${done.command}" hook claude-pretooluse`);
    expect((await installer().install(["codex"])).rows[0].status).toBe("unchanged");
    expect((await installer().list()).find((row) => row.harness === "claudeAgent")?.status).toBe("installed");
  });

  it("leaves a symbolic link at ~/.local/bin/omb alone", async () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(OMB, join(home, ".local", "bin", "omb"));
    await installer().install(["codex"]);
    expect(readFileSync(join(home, ".local", "bin", "omb"), "utf8")).toBe(readFileSync(OMB, "utf8"));
  });

  it("answers that the server has no omb command when the file is missing, and a bad id with exit 2", async () => {
    await expect(installer({ source: join(home, "none.mjs") }).install(["codex"])).rejects.toMatchObject({ exit: 5 });
    await expect(installer().install(["nope"])).rejects.toMatchObject({ exit: 2 });
  });

  it("says the server's computer is not paired after an install there", async () => {
    expect((await installer().install(["codex"])).notes).toEqual([{ key: "serverNotPaired" }]);
  });

  it("refuses to list or install on Windows, where omb does not run, and writes nothing", async () => {
    await expect(installer({ platform: "win32" }).list()).rejects.toMatchObject({ exit: 5, code: "not_available" });
    await expect(installer({ platform: "win32" }).install(["codex"])).rejects.toMatchObject({ exit: 5 });
    expect(existsSync(join(home, ".local", "bin", "omb"))).toBe(false);
  });

  it("leaves an omb copy that Node runs although the file has no extension", () => {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    return installer().install(["codex"]).then(({ command }) => {
      expect(execFileSync(process.execPath, [command, "version"], { env: { PATH: "" }, encoding: "utf8" }).trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });
});
