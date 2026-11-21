// The real bin/omb.mjs as a child of a fake agent (a Node script under @anthropic-ai/claude-code/), against a local stub server.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sha256File } from "../../bin/omb.mjs";
import { removeTempDir } from "../testing/cleanup.ts";
import { envelope, failure, startStub, type StubHandler } from "../testing/omb-cli-kit.ts";

const OMB = fileURLToPath(new URL("../../bin/omb.mjs", import.meta.url));
const TOKEN = "omb_sess_RUNTESTTOKEN1234567890abcdefghijklmnopqrstu";
const SECRET = "sk-live_RunSecret/9+zz==Q 42";

let root = "";
let agentScript = "";
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omb-run-"));
  const dir = join(root, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(dir, { recursive: true });
  agentScript = join(dir, "cli.js");
  writeFileSync(agentScript, [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, [process.env.OMB_BIN, ...JSON.parse(process.env.OMB_ARGS)], { stdio: "inherit" });',
    'require("node:fs").writeFileSync(process.env.OMB_PIDFILE, String(child.pid));',
    'child.on("close", (code) => process.exit(code ?? 1));',
  ].join("\n"));
  mkdirSync(join(root, "config"));
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await removeTempDir(root);
});

async function stub(handler: StubHandler) {
  const started = await startStub(handler);
  closers.push(started.close);
  return started;
}

function pair(url: string) {
  writeFileSync(join(root, "config", "config.json"), JSON.stringify({ schema_version: 1, server: url, scope: "secrets", store: "file" }));
  writeFileSync(join(root, "config", "token"), `${TOKEN}\n`, { mode: 0o600 });
}

interface Ran { code: number | null; stdout: string; stderr: string }

/** Starts omb under the fake agent; `signalOnOutput` signals omb once the program has printed that text. */
function runOmb(args: string[], options: { stdin?: string; signalOnOutput?: { text: string; signal: NodeJS.Signals } } = {}): Promise<Ran> {
  const pidFile = join(root, "omb.pid");
  const child = spawn(process.execPath, [agentScript], {
    env: {
      PATH: process.env.PATH, HOME: root, OMB_CONFIG_DIR: join(root, "config"), OMB_TOKEN_STORE: "file", OMB_BIN: OMB, OMB_ARGS: JSON.stringify(args), OMB_PIDFILE: pidFile,
      PASEO_AGENT_ID: "agent-7", PASEO_AGENT_CWD: root, OMB_CANARY: "must-not-reach-the-program", HTTPS_PROXY: "http://proxy.invalid",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let signalled = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (options.signalOnOutput && !signalled && stdout.includes(options.signalOnOutput.text)) {
      signalled = true;
      process.kill(Number(readFileSync(pidFile, "utf8")), options.signalOnOutput.signal);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(options.stdin ?? "");
  return new Promise((done) => child.once("close", (code) => done({ code, stdout, stderr })));
}

const nodeProgram = (script: string) => ["--", process.execPath, "-e", script];
const agentFingerprint = () => sha256File(agentScript);

describe.skipIf(process.platform === "win32")("omb under a fake agent", () => {
  it("names the agent by its script, sends the contract body and prints the response", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.fetch", { status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from("ok [omb:API_KEY]").toString("base64"), truncated: false }) }));
    pair(seen.url);
    const ran = await runOmb(["secrets", "fetch", "API_KEY", "https://api.example.com/v1", "--purpose", "sync"]);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe("ok [omb:API_KEY]");
    expect(seen.requests[0]!.body).toMatchObject({ ref: "API_KEY", url: "https://api.example.com/v1", method: "GET", purpose: "sync", fingerprint: await agentFingerprint(), agentLabel: "claude", agentId: "agent-7", cwd: root });
  });

  it("runs the program with only the granted variable, a rebuilt environment and scrubbed output, and returns its exit code", async () => {
    const seen = await stub((request) => ({ json: envelope("secrets.run", { values: request.body.scopes.map((scope: { var: string; ref: string }) => ({ var: scope.var, ref: scope.ref, value: SECRET })) }) }));
    pair(seen.url);
    const script = [
      "const s = process.env.API_TOKEN;",
      'console.log("raw:" + s);',
      'console.log("b64:" + Buffer.from(s).toString("base64"));',
      'console.log("b64url:" + Buffer.from(s).toString("base64url"));',
      'console.log("url:" + encodeURIComponent(s));',
      'console.log("hex:" + Buffer.from(s).toString("hex"));',
      'process.stderr.write("err:" + s + "\\n");',
      'console.log("vars:" + Object.keys(process.env).sort().join(","));',
      "process.exit(3);",
    ].join("\n");
    const ran = await runOmb(["secrets", "run", "--env", "API_TOKEN=API_KEY", "--purpose", "deploy", ...nodeProgram(script)]);
    expect(ran.code).toBe(3);
    for (const line of ["raw:", "b64:", "b64url:", "url:", "hex:"]) expect(ran.stdout).toContain(`${line}[omb:API_KEY]`);
    expect(ran.stderr).toContain("err:[omb:API_KEY]");
    const names = /vars:(.*)/.exec(ran.stdout)![1]!.split(",");
    expect(names).toContain("API_TOKEN");
    expect(names).toContain("PATH");
    for (const hidden of ["OMB_CANARY", "HTTPS_PROXY", "OMB_CONFIG_DIR", "OMB_ARGS", "PASEO_AGENT_ID"]) expect(names).not.toContain(hidden);
    for (const output of [ran.stdout, ran.stderr]) {
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain(Buffer.from(SECRET).toString("base64"));
    }
    expect(seen.requests[0]!.path).toBe("/api/secrets/run-check");
    expect(seen.requests[0]!.body).toMatchObject({ fingerprint: await agentFingerprint(), purpose: "deploy", agentLabel: "claude", agentId: "agent-7" });
    expect(seen.requests[0]!.body.scopes).toEqual([{ var: "API_TOKEN", ref: "API_KEY", program: { path: realpathSync(process.execPath), hash: await sha256File(process.execPath) } }]);
  });

  it("passes stdin through to the program", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.run", { values: [{ var: "T", ref: "API_KEY", value: SECRET }] }) }));
    pair(seen.url);
    const ran = await runOmb(["secrets", "run", "--env", "T=API_KEY", ...nodeProgram("process.stdin.pipe(process.stdout)")], { stdin: `echo ${SECRET} end` });
    expect(ran.stdout).toBe("echo [omb:API_KEY] end");
  });

  it("never starts the program on approval pending, a missing value, an unreachable server or a program that changed", async () => {
    const marker = join(root, "started");
    const program = join(root, "tool");
    const writeTool = (text: string) => { writeFileSync(program, `#!${process.execPath}\n${text}\n`); chmodSync(program, 0o755); };
    const original = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`;
    const cases: Array<[string, StubHandler, number]> = [
      ["pending", () => ({ status: 409, json: failure(8, "approval_pending", "A person was asked.") }), 8],
      ["blocked", () => ({ status: 403, json: failure(6, "blocked", "blocked") }), 6],
      ["limited", () => ({ status: 429, json: failure(9, "rate_limited", "slow") }), 9],
      ["missing value", () => ({ json: envelope("secrets.run", { values: [] }) }), 5],
      ["empty value", () => ({ json: envelope("secrets.run", { values: [{ var: "T", ref: "API_KEY", value: "" }] }) }), 5],
      ["changed program", () => { writeTool("// swapped"); return { json: envelope("secrets.run", { values: [{ var: "T", ref: "API_KEY", value: SECRET }] }) }; }, 6],
    ];
    for (const [name, handler, expected] of cases) {
      writeTool(original);
      const seen = await stub(handler);
      pair(seen.url);
      const ran = await runOmb(["secrets", "run", "--env", "T=API_KEY", "--", program]);
      expect(ran.code, name).toBe(expected);
      expect(existsSync(marker), name).toBe(false);
      expect(ran.stdout + ran.stderr, name).not.toContain(SECRET);
      if (expected === 8) expect(ran.stderr).toContain('"already approved omb secrets: API_KEY"');
    }
    writeTool(original);
    const down = await stub(() => ({}));
    pair(down.url);
    await down.close();
    const ran = await runOmb(["secrets", "run", "--env", "T=API_KEY", "--", program]);
    expect(ran.code).toBe(5);
    expect(existsSync(marker)).toBe(false);
  });

  it("starts the same program when the server releases the value", async () => {
    const marker = join(root, "started");
    const program = join(root, "tool");
    writeFileSync(program, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")\n`);
    chmodSync(program, 0o755);
    const seen = await stub(() => ({ json: envelope("secrets.run", { values: [{ var: "T", ref: "API_KEY", value: SECRET }] }) }));
    pair(seen.url);
    expect((await runOmb(["secrets", "run", "--env", "T=API_KEY", "--", program])).code).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it("refuses a released value an environment cannot carry, without printing it", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.run", { values: [{ var: "T", ref: "API_KEY", value: "NULVALUE\u0000TAIL" }] }) }));
    pair(seen.url);
    const ran = await runOmb(["secrets", "run", "--env", "T=API_KEY", ...nodeProgram("console.log('started')")]);
    expect(ran.code).toBe(5);
    expect(ran.stdout + ran.stderr).not.toContain("NULVALUE");
    expect(ran.stdout).not.toContain("started");
  });

  it("refuses a shell or a loader variable before asking the server", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.run", { values: [] }) }));
    pair(seen.url);
    expect((await runOmb(["secrets", "run", "--env", "T=API_KEY", "--", "/bin/sh", "-c", "true"])).code).toBe(2);
    expect((await runOmb(["secrets", "run", "--env", "LD_PRELOAD=API_KEY", ...nodeProgram("1")])).code).toBe(2);
    expect(seen.requests).toHaveLength(0);
  });

  it("forwards SIGTERM to the program and returns its exit code", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.run", { values: [{ var: "T", ref: "API_KEY", value: SECRET }] }) }));
    pair(seen.url);
    const marker = join(root, "got-term");
    const script = `process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"); process.exit(7); }); console.log("ready"); setInterval(() => {}, 1000);`;
    const ran = await runOmb(["secrets", "run", "--env", "T=API_KEY", ...nodeProgram(script)], { signalOnOutput: { text: "ready", signal: "SIGTERM" } });
    expect(ran.code).toBe(7);
    expect(existsSync(marker)).toBe(true);
  });
});
