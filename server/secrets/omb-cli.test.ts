import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  allowedServerOrigin as cliAllowedOrigin, checkEnvVar, configDir, createScrubber, EXIT, findAgent, HARNESSES, main, parseArgs, pinProgram, readPairingCode,
  readPairingTarget, sha256File, valueForms, type Deps,
} from "../../bin/omb.mjs";
import { allowedServerOrigin } from "../../electron/server-address.mjs";
import { envelope, failure, fakePs, memoryOutput, startStub, type StubHandler } from "../testing/omb-cli-kit.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const posix = process.platform !== "win32";
const TOKEN = "omb_sess_TESTTOKENVALUE1234567890abcdefghijklmnopq";

let home = "";
const closers: Array<() => Promise<void>> = [];

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "omb-cli-")); });
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await removeTempDir(home);
});

async function stub(handler: StubHandler) {
  const started = await startStub(handler);
  closers.push(started.close);
  return started;
}

/** A process table whose parent chain 100 -> 50 -> 10 holds one agent binary at pid 50. */
async function agentTable() {
  const agent = join(home, "claude");
  writeFileSync(agent, "fake agent binary");
  return { agent, ps: fakePs({ 100: { ppid: 50, comm: "/bin/zsh" }, 50: { ppid: 10, comm: agent }, 10: { ppid: 1, comm: "/sbin/launchd" } }) };
}

async function run(argv: string[], overrides: Partial<Deps> = {}, stdin = "") {
  const out = memoryOutput();
  const err = memoryOutput();
  const code = await main(argv, {
    env: { OMB_CONFIG_DIR: join(home, "config"), OMB_TOKEN_STORE: "file", PATH: process.env.PATH, PASEO_AGENT_ID: "agent-1", PASEO_AGENT_CWD: "/work/site" },
    home, platform: "darwin", ppid: 100, stdin: Readable.from([Buffer.from(stdin)]), stdinIsTTY: false, stdout: out.stream, stderr: err.stream, cwd: () => home, ...overrides,
  });
  return { code, out: out.text(), err: err.text() };
}

async function paired(url: string) {
  const dir = join(home, "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ schema_version: 1, server: url, scope: "secrets", store: "file", expiresAt: 4_102_444_800_000 }));
  writeFileSync(join(dir, "token"), `${TOKEN}\n`, { mode: 0o600 });
}

describe("arguments", () => {
  const spec = { env: "repeat", purpose: "value", include: "bool" } as const;

  it("reads --flag value, --flag=value, repeats and the global flags", () => {
    const parsed = parseArgs(["--env", "A=B", "--env=C=D", "--purpose=x y", "-q", "ref", "--json"], spec);
    expect(parsed.flags).toEqual({ env: ["A=B", "C=D"], purpose: "x y", quiet: true, json: true });
    expect(parsed.positionals).toEqual(["ref"]);
  });

  it("keeps everything after -- as positionals, flags included", () => {
    expect(parseArgs(["--include", "--", "--env", "-q"], spec)).toEqual({ flags: { include: true }, positionals: ["--env", "-q"] });
  });

  it("refuses an unknown flag, a missing value and a value on a switch", () => {
    for (const tokens of [["--nope"], ["--purpose"], ["--include=1"], ["-v"], ["-qv"]]) {
      expect(() => parseArgs(tokens, spec)).toThrowError(expect.objectContaining({ exitCode: EXIT.invalid }));
    }
    expect(parseArgs(["-"], spec).positionals).toEqual(["-"]);
  });

  it("answers exit 2 for a stray argument on a command that takes none", async () => {
    for (const argv of [["status", "extra"], ["secrets", "list", "X"], ["secrets", "grants", "API_KEY"], ["secrets", "audit", "API_KEY"]]) {
      expect((await run(argv)).code).toBe(EXIT.invalid);
    }
  });

  it("answers exit 2 for an unknown command and for run without --", async () => {
    expect((await run(["frobnicate"])).code).toBe(EXIT.invalid);
    expect((await run(["secrets", "resolve", "X"])).code).toBe(EXIT.invalid);
    const noProgram = await run(["secrets", "run", "--env", "T=REF", "--json"]);
    expect(noProgram.code).toBe(EXIT.invalid);
    expect(JSON.parse(noProgram.out)).toMatchObject({ schema_version: 1, error_code: "invalid_request", exit_code: 2 });
  });

  it.each(["set", "rotate", "delete", "grant", "revoke", "approve"])("sends %s to the OpenMausBot app with exit 6", async (name) => {
    const result = await run(["secrets", name, "REF"]);
    expect(result.code).toBe(EXIT.refused);
    expect(result.err).toContain("OpenMausBot app");
  });

  it("refuses get --reveal with exit 6 before any request", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.get", {}) }));
    await paired(seen.url);
    const result = await run(["secrets", "get", "REF", "--reveal"]);
    expect(result.code).toBe(EXIT.refused);
    expect(seen.requests).toHaveLength(0);
  });
});

describe("server address and pairing input", () => {
  const hosts = ["localhost", "a.localhost", "127.0.0.1", "[::1]", "10.0.0.5", "172.16.0.1", "172.31.255.1", "172.32.0.1", "192.168.1.1", "100.64.0.1", "100.127.0.1", "100.128.0.1",
    "169.254.1.1", "mac.tail1234.ts.net", "host.local", "host.home.arpa", "intranet", "example.com", "8.8.8.8", "1.2.3", "999.1.1.1", "[fd00::1]", "[fe80::1]", "[2001:db8::1]", "user:pw@host", "ts.net"];

  it.each(hosts.flatMap((host) => [`http://${host}`, `https://${host}`]))("agrees with the app on %s", (origin) => {
    expect(cliAllowedOrigin(origin)).toBe(allowedServerOrigin(origin));
  });

  it("reads a link, a loosely typed code and a code with --server", () => {
    expect(readPairingCode("abcd efgh-jklm")).toBe("ABCD-EFGH-JKLM");
    expect(readPairingCode("ABCD-EFGH")).toBeNull();
    expect(readPairingTarget("https://maus.example.com/pair#code=ABCD-EFGH-JKLM")).toEqual({ origin: "https://maus.example.com", secret: "ABCD-EFGH-JKLM" });
    expect(readPairingTarget("ABCD-EFGH-JKLM", "http://100.64.1.2:8799")).toEqual({ origin: "http://100.64.1.2:8799", secret: "ABCD-EFGH-JKLM" });
    expect(() => readPairingTarget("ABCD-EFGH-JKLM")).toThrowError(/--server/);
    expect(() => readPairingTarget("http://example.com/pair#code=ABCD-EFGH-JKLM")).toThrowError(/not allowed/);
    expect(() => readPairingTarget("https://maus.example.com/other#code=ABCD-EFGH-JKLM")).toThrowError(/not a pairing link/);
    expect(() => readPairingTarget("omb_sess_abc")).toThrowError(/token-stdin/);
  });
});

describe.skipIf(!posix)("identity walk", () => {
  it("finds an agent by its binary name through a fake ps and hashes the file", async () => {
    const path = join(home, "claude");
    writeFileSync(path, "agent");
    const found = await findAgent({ platform: "darwin", startPid: 100, ps: fakePs({ 100: { ppid: 50, comm: "/bin/zsh" }, 50: { ppid: 10, comm: path }, 10: { ppid: 1, comm: "/sbin/launchd" } }) });
    expect(found).toMatchObject({ name: "claude", fingerprint: await sha256File(path) });
    expect(found!.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("matches a native Claude Code install by its versions path", async () => {
    mkdirSync(join(home, "claude", "versions"), { recursive: true });
    const binary = join(home, "claude", "versions", "2.1.50");
    writeFileSync(binary, "x");
    const found = await findAgent({ platform: "darwin", startPid: 7, ps: fakePs({ 7: { ppid: 1, comm: binary } }) });
    expect(found?.name).toBe("claude");
  });

  it("matches a node-hosted agent by argv and hashes its script, not node", async () => {
    mkdirSync(join(home, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    const script = join(home, "node_modules", "@openai", "codex", "bin", "codex.js");
    writeFileSync(script, "console.log(1)");
    const found = await findAgent({ platform: "darwin", startPid: 7, ps: fakePs({ 7: { ppid: 1, comm: "/usr/local/bin/node", args: `node ${script} --flag` } }) });
    expect(found).toMatchObject({ name: "codex", fingerprint: await sha256File(script) });
  });

  it("does not take a plain node process, a shell or an unreadable table for an agent", async () => {
    const ps = fakePs({ 7: { ppid: 6, comm: "/usr/local/bin/node", args: "node server.js" }, 6: { ppid: 1, comm: "/bin/zsh" } });
    expect(await findAgent({ platform: "darwin", startPid: 7, ps })).toBeNull();
    const server = join(home, "server.js");
    writeFileSync(server, "console.log(1)");
    for (const args of [`node ${server} --provider claude`, `node ${server} pi`, "node node_modules/@openai/codex/bin/codex.js"]) {
      expect(await findAgent({ platform: "darwin", startPid: 7, ps: fakePs({ 7: { ppid: 1, comm: "/usr/local/bin/node", args } }) })).toBeNull();
    }
    expect(await findAgent({ platform: "darwin", startPid: 999, ps })).toBeNull();
    expect(await findAgent({ platform: "win32", startPid: 7, ps })).toBeNull();
  });

  it("names every harness that has a skill folder by its binary, each with its own label", async () => {
    const named = HARNESSES.filter((harness) => harness.base !== null);
    const labels = new Set<string>();
    for (const harness of named) {
      expect(harness.recognised).toBe(true);
      const binary = join(home, `${harness.id}-bin`, harness.agent!.name === "cursor" ? "cursor-agent.js" : harness.agent!.name === "kiro" ? "kiro-cli" : harness.agent!.name === "antigravity" ? "agy" : harness.agent!.name);
      mkdirSync(join(home, `${harness.id}-bin`), { recursive: true });
      writeFileSync(binary, harness.id);
      const comm = harness.agent!.name === "cursor" ? "/usr/local/bin/node" : binary;
      const found = await findAgent({ platform: "darwin", startPid: 7, ps: fakePs({ 7: { ppid: 6, comm: "/bin/zsh" }, 6: { ppid: 1, comm, args: `node ${binary}` } }) });
      expect(found, harness.id).toMatchObject({ name: harness.agent!.name, fingerprint: await sha256File(binary) });
      labels.add(found!.name);
    }
    expect(labels.size).toBe(named.length);
    const deepseek = HARNESSES.find((harness) => harness.id === "deepseekAgent")!;
    expect(deepseek.recognised).toBe(false);
    expect(deepseek.agent).toBeUndefined();
  });

  it("hashes the script the Cursor launcher's Node hosts, never the launcher or the bundled Node", async () => {
    const versions = join(home, ".local", "share", "cursor-agent", "versions", "2026.11.22-e9042b2");
    mkdirSync(versions, { recursive: true });
    const script = join(versions, "index.js");
    writeFileSync(script, "cursor");
    writeFileSync(join(versions, "node"), "bundled node");
    const launcher = join(home, ".local", "bin", "cursor-agent");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(launcher, "#!/usr/bin/env bash");
    for (const comm of [launcher, join(home, ".local", "bin", "agent")]) {
      const ps = fakePs({ 9: { ppid: 8, comm: "/bin/zsh" }, 8: { ppid: 1, comm, args: `${comm} --disable-sigusr1 --use-system-ca ${script} acp` } });
      expect(await findAgent({ platform: "darwin", startPid: 9, ps })).toMatchObject({ name: "cursor", fingerprint: await sha256File(script), path: realpathSync(script) });
    }
    const linux = fakePs({ 8: { ppid: 1, comm: join(versions, "node"), args: `cursor-agent --use-system-ca ${script} acp` } });
    expect(await findAgent({ platform: "darwin", startPid: 8, ps: linux })).toMatchObject({ name: "cursor", fingerprint: await sha256File(script) });
    const bare = fakePs({ 8: { ppid: 1, comm: launcher, args: `${launcher} --use-system-ca` } });
    expect(await findAgent({ platform: "darwin", startPid: 8, ps: bare })).toBeNull();
    const other = join(home, "agent.js");
    writeFileSync(other, "x");
    expect(await findAgent({ platform: "darwin", startPid: 8, ps: fakePs({ 8: { ppid: 1, comm: "/opt/bin/agent", args: `agent ${other}` } }) })).toBeNull();
  });

  it("names a Python-hosted agent by its script and keeps pi and omp apart", async () => {
    const hermes = join(home, "venv", "bin", "hermes");
    mkdirSync(join(home, "venv", "bin"), { recursive: true });
    writeFileSync(hermes, "from hermes_cli.main import main");
    for (const python of [join(home, "venv", "bin", "python3.12"), "/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python"]) {
      const found = await findAgent({ platform: "darwin", startPid: 7, ps: fakePs({ 7: { ppid: 1, comm: python, args: `${python} ${hermes} acp` } }) });
      expect(found).toMatchObject({ name: "hermes", fingerprint: await sha256File(hermes) });
    }
    const plain = join(home, "tool.py");
    writeFileSync(plain, "print(1)");
    for (const args of [`python3 ${plain} hermes`, "python3 -m hermes_cli.main"]) {
      expect(await findAgent({ platform: "darwin", startPid: 7, ps: fakePs({ 7: { ppid: 1, comm: "/usr/bin/python3", args } }) })).toBeNull();
    }
    for (const [scope, name] of [["@oh-my-pi", "omp"], ["@earendil-works", "pi"]] as const) {
      const dir = join(home, "node_modules", scope, "pi-coding-agent", "dist");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "cli.js"), scope);
      const hosted = await findAgent({ platform: "darwin", startPid: 7, ps: fakePs({ 7: { ppid: 1, comm: "/usr/local/bin/bun", args: `bun ${join(dir, "cli.js")}` } }) });
      expect(hosted?.name).toBe(name);
    }
  });

  it("stops on a loop in the table", async () => {
    expect(await findAgent({ platform: "darwin", startPid: 7, ps: fakePs({ 7: { ppid: 8, comm: "/bin/a" }, 8: { ppid: 7, comm: "/bin/b" } }) })).toBeNull();
  });

  it.skipIf(!posix)("walks /proc on Linux: exe, cmdline and a stat whose name holds ')'", async () => {
    const root = join(home, "proc");
    const proc = (pid: number, ppid: number, exe: string, cmdline: string[]) => {
      mkdirSync(join(root, String(pid)), { recursive: true });
      writeFileSync(join(root, String(pid), "stat"), `${pid} (we) ird) S ${ppid} 1 1 0 -1 4194560`);
      writeFileSync(join(root, String(pid), "cmdline"), `${cmdline.join("\0")}\0`);
      symlinkSync(exe, join(root, String(pid), "exe"));
    };
    const opencode = join(home, "opencode");
    writeFileSync(opencode, "oc");
    proc(30, 20, "/bin/bash", ["bash"]);
    proc(20, 10, opencode, ["opencode"]);
    proc(10, 1, "/sbin/init", ["init"]);
    const found = await findAgent({ platform: "linux", startPid: 30, procRoot: root, ps: async () => { throw new Error("ps must not run on Linux"); } });
    expect(found).toMatchObject({ name: "opencode", fingerprint: await sha256File(opencode) });
  });

  it("answers exit 6 without any request when no agent is above the process", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.grants", []) }));
    await paired(seen.url);
    const result = await run(["secrets", "grants"], { ps: fakePs({ 100: { ppid: 1, comm: "/bin/zsh" } }) });
    expect(result.code).toBe(EXIT.refused);
    expect(result.err).toContain("no known agent");
    expect(seen.requests).toHaveLength(0);
  });
});

describe.skipIf(!posix)("server answers", () => {
  it.each([
    [409, failure(8, "approval_pending", "A person was asked."), EXIT.pending],
    [404, failure(3, "no_such_secret", "no such secret"), EXIT.missing],
    [409, failure(4, "exists", "exists"), EXIT.exists],
    [403, failure(6, "blocked", "blocked"), EXIT.refused],
    [429, failure(9, "rate_limited", "slow down"), EXIT.limited],
    [503, failure(5, "store_unavailable", "ledger down"), EXIT.unreachable],
    [400, failure(2, "invalid_request", "bad ref"), EXIT.invalid],
    [400, failure(77, "odd", "odd"), EXIT.unreachable],
  ])("maps HTTP %i with an envelope to exit %i", async (status, body, expected) => {
    const seen = await stub(() => ({ status, json: body }));
    await paired(seen.url);
    const { agent, ps } = await agentTable();
    expect(agent).toBeTruthy();
    const result = await run(["secrets", "grants", "--json"], { ps });
    expect(result.code).toBe(expected);
    const printed = JSON.parse(result.out);
    expect(Object.keys(printed).sort()).toEqual(["error", "error_code", "exit_code", "schema_version"]);
    expect(printed.exit_code).toBe(expected);
  });

  it.each([
    [401, { error: "unauthorized: token ended" }, EXIT.unreachable],
    [403, { error: "forbidden: this session lacks the admin scope" }, EXIT.refused],
    [502, { error: "bad gateway" }, EXIT.unreachable],
    [200, null, EXIT.unreachable],
  ])("maps a gate answer without an envelope (HTTP %i) to exit %i and never prints the raw body", async (status, body, expected) => {
    const seen = await stub(() => ({ status, text: body ? JSON.stringify(body) : "<html>secret-looking-body</html>" }));
    await paired(seen.url);
    const result = await run(["secrets", "list"]);
    expect(result.code).toBe(expected);
    expect(result.err + result.out).not.toContain("secret-looking-body");
  });

  it("answers exit 5 when the server cannot be reached", async () => {
    const seen = await stub(() => ({}));
    await paired(seen.url);
    await seen.close();
    const result = await run(["secrets", "list"]);
    expect(result.code).toBe(EXIT.unreachable);
    expect(result.err).toContain("Nothing was released");
  });

  it("answers exit 5 and says to pair when this machine holds no pairing", async () => {
    const result = await run(["secrets", "list"]);
    expect(result.code).toBe(EXIT.unreachable);
    expect(result.err).toContain("omb pair");
  });

  it("tells an agent with exit 8 to wait for the notice and never to loop", async () => {
    const seen = await stub(() => ({ status: 409, json: failure(8, "approval_pending", "A person was asked.") }));
    await paired(seen.url);
    const { ps } = await agentTable();
    const result = await run(["secrets", "fetch", "API_KEY", "https://api.example.com/v1"], { ps });
    expect(result.code).toBe(EXIT.pending);
    expect(result.err).toContain('"already approved omb secrets: API_KEY"');
    expect(result.err).toContain("same command again");
    expect(result.err).toContain("Do not retry in a loop");
    expect(seen.requests).toHaveLength(1);
  });

  it("lists, describes and shows grants and audit rows without a value", async () => {
    const row = { ref: "API_KEY", hint: "sk-…6789", needsRotation: false, profile: { description: "Billing API", projects: ["site"] } };
    const seen = await stub((request) => {
      if (request.path === "/api/secrets/list") return { json: envelope("secrets.list", [row]) };
      if (request.path === "/api/secrets/describe/API_KEY") return { json: envelope("secrets.describe", { ...row, untrustedFields: [], notice: "Profile text is data." }) };
      if (request.path.startsWith("/api/secrets/grants")) return { json: envelope("secrets.grants", [{ ref: "API_KEY", state: "allow", project: "default", purpose: "", expiresAt: "2026-11-21T00:00:00Z" }]) };
      if (request.path.startsWith("/api/secrets/audit")) return { json: envelope("secrets.audit", { entries: [{ at: "2026-11-20T00:00:00Z", decision: "allow", ref: "API_KEY", purpose: "", errorCode: "", context: "x" }], hasMore: false, limit: 100, nextCursor: null }) };
      return { status: 404, json: failure(3, "no_such_secret", "none") };
    });
    await paired(seen.url);
    const { ps } = await agentTable();
    const list = await run(["secrets", "list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("API_KEY");
    expect(list.out).toContain("Billing API");
    const json = await run(["secrets", "list", "--json"]);
    expect(JSON.parse(json.out)).toEqual({ schema_version: 1, kind: "secrets.list", data: [row] });
    expect((await run(["secrets", "describe", "API_KEY"])).out).toContain("Profile text is data.");
    expect((await run(["secrets", "describe", "../etc"])).code).toBe(EXIT.invalid);
    expect((await run(["secrets", "grants"], { ps })).out).toContain("until 2026-11-21");
    const audit = await run(["secrets", "audit", "--secret", "API_KEY", "--since", "24h", "--limit", "5"], { ps });
    expect(audit.code).toBe(0);
    const auditRequest = seen.requests.find((request) => request.path.startsWith("/api/secrets/audit"))!;
    expect(new URL(`http://x${auditRequest.path}`).searchParams.get("ref")).toBe("API_KEY");
    expect(new URL(`http://x${auditRequest.path}`).searchParams.get("fingerprint")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await run(["secrets", "audit", "--limit", "900"], { ps })).code).toBe(EXIT.invalid);
    expect(seen.requests.every((request) => request.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("files a request with the pinned program and reports covered, pending and granted", async () => {
    const answers = ["covered", "pending", "granted"];
    const seen = await stub((request) => ({ json: envelope("secrets.request", { status: answers[(request.body.purpose ?? "").length] }) }));
    await paired(seen.url);
    const { ps } = await agentTable();
    for (const [index, status] of answers.entries()) {
      const result = await run(["secrets", "request", "API_KEY", "--purpose", "x".repeat(index), "--exec", process.execPath, "--env", "TOKEN", "--json"], { ps });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out).data.status).toBe(status);
    }
    expect(seen.requests[0]!.body).toMatchObject({ ref: "API_KEY", env: "TOKEN", exec: { hash: await sha256File(process.execPath) }, agentId: "agent-1", cwd: "/work/site", agentLabel: "claude" });
    expect((await run(["secrets", "request", "API_KEY", "--exec", process.execPath], { ps })).code).toBe(EXIT.invalid);
  });
});

describe.skipIf(!posix)("fetch request", () => {
  it("sends the contract body and prints the response body, with status and headers on --include", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.fetch", { status: 201, headers: { "content-type": "text/plain", "set-cookie": ["a=1", "b=2"] }, body: Buffer.from("hello [omb:API_KEY]").toString("base64"), truncated: false }) }));
    await paired(seen.url);
    const { agent, ps } = await agentTable();
    const dataFile = join(home, "payload.json");
    writeFileSync(dataFile, '{"a":1}');
    const result = await run(["secrets", "fetch", "API_KEY", "https://API.example.com/v1/items?x=1", "--method", "post", "--header", "Content-Type: application/json", "--data", `@${dataFile}`,
      "--inject", "header:X-Api-Key", "--purpose", "sync", "--project", "site", "--session", "s1", "--include"], { ps });
    expect(result.code).toBe(0);
    expect(result.out).toBe("HTTP 201\ncontent-type: text/plain\nset-cookie: a=1\nset-cookie: b=2\n\nhello [omb:API_KEY]");
    const request = seen.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/secrets/fetch");
    expect(request.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
    expect(request.body).toEqual({
      ref: "API_KEY", url: "https://api.example.com/v1/items?x=1", method: "POST", headers: { "Content-Type": "application/json" }, body: Buffer.from('{"a":1}').toString("base64"),
      inject: { as: "header", name: "X-Api-Key" }, purpose: "sync", project: "site", session: "s1",
      fingerprint: await sha256File(agent), agentLabel: "claude", agentId: "agent-1", cwd: "/work/site",
    });
  });

  it("omits optional fields it was not given and reads --data - from stdin", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.fetch", { status: 200, headers: {}, body: "", truncated: false }) }));
    await paired(seen.url);
    const { ps } = await agentTable();
    await run(["secrets", "fetch", "API_KEY", "https://api.example.com/"], { ps });
    expect(Object.keys(seen.requests[0]!.body).sort()).toEqual(["agentId", "agentLabel", "cwd", "fingerprint", "method", "ref", "url"]);
    await run(["secrets", "fetch", "API_KEY", "https://api.example.com/", "--data", "-", "--inject", "basic-password"], { ps }, "from stdin");
    expect(seen.requests[1]!.body).toMatchObject({ body: Buffer.from("from stdin").toString("base64"), inject: { as: "basic-password" } });
  });

  it("prints the JSON envelope for --json and a note for a cut or failed response", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.fetch", { status: 502, headers: {}, body: Buffer.from("x").toString("base64"), truncated: true }) }));
    await paired(seen.url);
    const { ps } = await agentTable();
    const plain = await run(["secrets", "fetch", "API_KEY", "https://api.example.com/"], { ps });
    expect(plain.code).toBe(0);
    expect(plain.err).toContain("size limit");
    expect(plain.err).toContain("HTTP 502");
    const json = await run(["secrets", "fetch", "API_KEY", "https://api.example.com/", "--json"], { ps });
    expect(JSON.parse(json.out)).toEqual({ schema_version: 1, kind: "secrets.fetch", data: { status: 502, headers: {}, body: "eA==", truncated: true } });
  });

  it.each([
    [["secrets", "fetch", "API_KEY"]],
    [["secrets", "fetch", "-bad", "https://a.example.com/"]],
    [["secrets", "fetch", "API_KEY", "http://a.example.com/"]],
    [["secrets", "fetch", "API_KEY", "https://user:pw@a.example.com/"]],
    [["secrets", "fetch", "API_KEY", "not a url"]],
    [["secrets", "fetch", "API_KEY", "https://a.example.com/", "--header", "Authorization: Bearer x"]],
    [["secrets", "fetch", "API_KEY", "https://a.example.com/", "--inject", "basic-password", "--header", "authorization: x"]],
    [["secrets", "fetch", "API_KEY", "https://a.example.com/", "--inject", "header:X-Key", "--header", "x-key: 1"]],
    [["secrets", "fetch", "API_KEY", "https://a.example.com/", "--header", "bad header"]],
    [["secrets", "fetch", "API_KEY", "https://a.example.com/", "--inject", "cookie"]],
    [["secrets", "fetch", "API_KEY", "https://a.example.com/", "--data", `@${"/does/not/exist"}`]],
    [["secrets", "fetch", "API_KEY", "https://a.example.com/", "--data", "x".repeat(70_000)]],
  ])("refuses %j with exit 2 before asking the server", async (argv) => {
    const seen = await stub(() => ({ json: envelope("secrets.fetch", {}) }));
    await paired(seen.url);
    const { ps } = await agentTable();
    const result = await run(argv, { ps });
    expect(result.code).toBe(EXIT.invalid);
    expect(seen.requests).toHaveLength(0);
  });

  it("allows http to localhost and refuses it elsewhere", async () => {
    const seen = await stub(() => ({ json: envelope("secrets.fetch", { status: 200, headers: {}, body: "", truncated: false }) }));
    await paired(seen.url);
    const { ps } = await agentTable();
    expect((await run(["secrets", "fetch", "API_KEY", "http://localhost:8080/x"], { ps })).code).toBe(0);
    expect((await run(["secrets", "fetch", "API_KEY", "http://127.0.0.2/x"], { ps })).code).toBe(0);
    expect((await run(["secrets", "fetch", "API_KEY", "http://10.0.0.1/x"], { ps })).code).toBe(EXIT.invalid);
  });
});

describe("pairing and storage", () => {
  const pairAnswer = (scopes: string[]) => ({ token: TOKEN, session: { id: "sess-1", scopes, expiresAt: 4_102_444_800_000, token: true } });

  it("pairs from a link, keeps the token in a 0600 file and never prints it", async () => {
    const seen = await stub((request) => (request.path === "/api/auth/pair" ? { json: pairAnswer(["secrets"]) } : { json: envelope("secrets.list", []) }));
    const result = await run(["pair", `${seen.url}/pair#code=ABCD-EFGH-JKLM`, "--label", "laptop"]);
    expect(result.code).toBe(0);
    expect(result.out + result.err).not.toContain(TOKEN);
    expect(seen.requests[0]!.body).toEqual({ code: "ABCD-EFGH-JKLM", label: "laptop" });
    const dir = configDir({ OMB_CONFIG_DIR: join(home, "config") }, home);
    expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe(TOKEN);
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain(TOKEN);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toMatchObject({ server: seen.url, scope: "secrets", store: "file", sessionId: "sess-1" });
    if (posix) {
      expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
    }
    const status = await run(["status", "--json"]);
    expect(status.code).toBe(0);
    const data = JSON.parse(status.out).data;
    expect(data).toMatchObject({ server: seen.url, scope: "secrets", reachable: true, tokenAccepted: true });
    expect(status.out).not.toContain(TOKEN);
  });

  it("ends a session that did not get exactly the secrets scope and stores nothing", async () => {
    // As server/request-auth.ts: logout is open to a client session, the sessions route only to admin.
    const gate = (scopes: string[]) => (request: { method: string; path: string }) => {
      if (request.path === "/api/auth/pair") return { json: pairAnswer(scopes) };
      if (request.method === "POST" && request.path === "/api/auth/logout") return scopes.includes("client") ? { json: { ok: true } } : { status: 403, json: { error: "forbidden" } };
      return scopes.includes("admin") ? { json: {} } : { status: 403, json: { error: "forbidden: this session lacks the admin scope" } };
    };
    const seen = await stub(gate(["client"]));
    const result = await run(["pair", `${seen.url}/pair#code=ABCD-EFGH-JKLM`]);
    expect(result.code).toBe(EXIT.refused);
    expect(result.out + result.err).not.toContain(TOKEN);
    expect(result.err).toContain("so it was ended");
    expect(seen.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/auth/logout", headers: { authorization: `Bearer ${TOKEN}` } });
    const admin = await stub(gate(["admin"]));
    expect((await run(["pair", `${admin.url}/pair#code=ABCD-EFGH-JKLM`])).code).toBe(EXIT.refused);
    expect(admin.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/auth/sessions/sess-1", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(existsSync(join(home, "config", "token"))).toBe(false);
    expect(existsSync(join(home, "config", "config.json"))).toBe(false);
  });

  it("reports a refused code with exit 5 and the server's reason", async () => {
    const seen = await stub(() => ({ status: 401, json: { error: "invalid or expired pairing code" } }));
    const result = await run(["pair", `${seen.url}/pair#code=ABCD-EFGH-JKLM`]);
    expect(result.code).toBe(EXIT.unreachable);
    expect(result.err).toContain("invalid or expired pairing code");
  });

  it("pairs with a token from stdin and refuses a token that reaches the admin routes", async () => {
    const seen = await stub((request) => {
      if (request.path === "/api/secrets/list") return { json: envelope("secrets.list", []) };
      return { status: 403, json: { error: "forbidden: this session lacks the admin scope" } };
    });
    const ok = await run(["pair", "--token-stdin", "--server", seen.url], {}, `${TOKEN}\n`);
    expect(ok.code).toBe(0);
    expect(readFileSync(join(home, "config", "token"), "utf8").trim()).toBe(TOKEN);
    const strong = await stub((request) => (request.path === "/api/secrets/list" || request.path === "/api/secrets/admin/grants" ? { json: envelope("x", []) } : { status: 404, json: {} }));
    const refused = await run(["pair", "--token-stdin", "--server", strong.url], {}, `${TOKEN}\n`);
    expect(refused.code).toBe(EXIT.refused);
    expect(refused.err).toContain("secrets scope only");
  });

  it("refuses a token typed on a terminal and a server it may not use", async () => {
    expect((await run(["pair", "--token-stdin", "--server", "http://127.0.0.1:1"], { stdinIsTTY: true })).code).toBe(EXIT.invalid);
    expect((await run(["pair", "--token-stdin", "--server", "http://example.com"], {}, TOKEN)).code).toBe(EXIT.invalid);
    expect((await run(["pair", "--token-stdin"], {}, TOKEN)).code).toBe(EXIT.invalid);
  });

  it("stores the token in the macOS keychain through stdin, never in argv", async () => {
    const seen = await stub((request) => (request.path === "/api/auth/pair" ? { json: pairAnswer(["secrets"]) } : { json: envelope("secrets.list", []) }));
    const calls: Array<{ args: string[]; input?: string }> = [];
    let kept = "";
    const security: Deps["security"] = async (args, input) => {
      calls.push({ args, input });
      if (args[0] === "-i") kept = /-w (\S+)/.exec(input ?? "")![1]!;
      return args[0] === "find-generic-password" ? `${kept}\n` : "";
    };
    const result = await run(["pair", `${seen.url}/pair#code=ABCD-EFGH-JKLM`], { platform: "darwin", security, env: { OMB_CONFIG_DIR: join(home, "config"), PATH: "" } });
    expect(result.code).toBe(0);
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain(TOKEN);
    expect(calls[0]!.input).toContain(`-w ${TOKEN}`);
    expect(existsSync(join(home, "config", "token"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, "config", "config.json"), "utf8")).store).toBe("keychain");
    const listed = await run(["secrets", "list"], { platform: "darwin", security, env: { OMB_CONFIG_DIR: join(home, "config"), PATH: "" } });
    expect(listed.code).toBe(0);
    expect(seen.requests.at(-1)!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("falls back to the 0600 file when the keychain is not available", async () => {
    const seen = await stub((request) => (request.path === "/api/auth/pair" ? { json: pairAnswer(["secrets"]) } : { json: envelope("secrets.list", []) }));
    const security: Deps["security"] = async () => { throw new Error("User interaction is not allowed."); };
    const result = await run(["pair", `${seen.url}/pair#code=ABCD-EFGH-JKLM`], { platform: "darwin", security, env: { OMB_CONFIG_DIR: join(home, "config"), PATH: "" } });
    expect(result.code).toBe(0);
    expect(result.err).toContain("keychain is not available");
    expect(result.err).not.toContain(TOKEN);
    expect(JSON.parse(readFileSync(join(home, "config", "config.json"), "utf8")).store).toBe("file");
    expect(readFileSync(join(home, "config", "token"), "utf8").trim()).toBe(TOKEN);
  });
});

describe("programs and variables", () => {
  it.each(["PATH", "HOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "PYTHONPATH", "RUBYOPT", "HTTPS_PROXY", "http_proxy", "SSL_CERT_FILE", "BASH_ENV", "JAVA_TOOL_OPTIONS", "AWS_ENDPOINT_URL_S3", "npm_config_registry", "LC_ALL", "1BAD", "A-B", ""])(
    "refuses %j as a secret variable", (name) => {
      expect(() => checkEnvVar(name)).toThrowError(expect.objectContaining({ exitCode: EXIT.invalid }));
    });

  it.each(["API_TOKEN", "NODE_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "_X"])("accepts %s", (name) => {
    expect(checkEnvVar(name)).toBe(name);
  });

  it.skipIf(!posix)("refuses shells, launchers, and scripts that start through them", async () => {
    const dir = join(home, "bin");
    mkdirSync(dir);
    const script = (name: string, body: string) => { const path = join(dir, name); writeFileSync(path, body); chmodSync(path, 0o755); return path; };
    for (const refused of ["/bin/sh", "/usr/bin/env", "/usr/bin/sudo", "/bin/bash"]) {
      if (existsSync(refused)) await expect(pinProgram(refused, {}, home)).rejects.toMatchObject({ exitCode: EXIT.invalid });
    }
    await expect(pinProgram(script("shell-script", "#!/bin/sh\necho x\n"), {}, home)).rejects.toThrowError(/#! line/);
    await expect(pinProgram(script("env-script", "#!/usr/bin/env python3\n"), {}, home)).rejects.toThrowError(/#! line/);
    await expect(pinProgram("sh", { PATH: "/bin:/usr/bin" }, home)).rejects.toMatchObject({ exitCode: EXIT.invalid });
    symlinkSync("/bin/sh", join(dir, "innocent"));
    await expect(pinProgram(join(dir, "innocent"), {}, home)).rejects.toThrowError(/shell or a launcher/);
    await expect(pinProgram("no-such-program", { PATH: dir }, home)).rejects.toMatchObject({ exitCode: EXIT.invalid });
    await expect(pinProgram(dir, {}, home)).rejects.toMatchObject({ exitCode: EXIT.invalid });
  });

  it.skipIf(!posix)("pins the resolved path and the content hash of a program", async () => {
    const dir = join(home, "bin");
    mkdirSync(dir);
    const real = join(dir, "tool-real");
    writeFileSync(real, `#!${process.execPath}\nconsole.log(1)\n`);
    chmodSync(real, 0o755);
    symlinkSync(real, join(dir, "tool"));
    const pinned = await pinProgram("tool", { PATH: dir }, home);
    expect(pinned.path).toBe(realpathSync(real));
    expect(pinned.hash).toBe(await sha256File(real));
  });
});

describe("scrubbing", () => {
  const VALUE = "sk-live_Ab/3+x=Z é!~ value 123";

  const feed = (secrets: Array<{ ref: string; value: string }>, parts: string[]) => {
    const scrubber = createScrubber(secrets);
    return Buffer.concat([...parts.map((part) => scrubber.push(Buffer.from(part, "latin1"))), scrubber.end()]).toString("latin1");
  };

  it("has the raw, base64, base64url, URL-encoded and hex forms", () => {
    const forms = valueForms(VALUE).map((form) => form.toString("latin1"));
    const raw = Buffer.from(VALUE);
    expect(forms).toContain(raw.toString("latin1"));
    expect(forms).toContain(raw.toString("base64").replace(/=+$/, ""));
    expect(forms).toContain(raw.toString("base64url"));
    expect(forms).toContain(encodeURIComponent(VALUE));
    expect(forms).toContain(encodeURIComponent(VALUE).replace(/%20/g, "+"));
    expect(forms).toContain(raw.toString("hex"));
    expect(forms).toContain(raw.toString("hex").toUpperCase());
    expect(forms).toContain(encodeURIComponent(VALUE).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase()));
  });

  it("replaces every form, however the output is cut into chunks", () => {
    for (const form of valueForms(VALUE)) {
      const text = `before ${form.toString("latin1")} after`;
      for (let cut = 0; cut <= text.length; cut++) {
        expect(feed([{ ref: "API_KEY", value: VALUE }], [text.slice(0, cut), text.slice(cut)])).toBe("before [omb:API_KEY] after");
      }
      expect(feed([{ ref: "API_KEY", value: VALUE }], [...text])).toBe("before [omb:API_KEY] after");
    }
  });

  it("replaces a value cut into three chunks and several values in one chunk", () => {
    expect(feed([{ ref: "A", value: "alpha-secret-1" }], ["x alpha-", "secret", "-1 y"])).toBe("x [omb:A] y");
    expect(feed([{ ref: "A", value: "alpha-secret-1" }, { ref: "B", value: "beta-secret-22" }], ["alpha-secret-1,beta-secret-22,alpha-secret-1"])).toBe("[omb:A],[omb:B],[omb:A]");
  });

  it("prefers the longer value when one is the start of another, even at a chunk end", () => {
    const secrets = [{ ref: "SHORT", value: "abcdefgh" }, { ref: "LONG", value: "abcdefghijklmnop" }];
    expect(feed(secrets, ["xabcdefghijklmnopy"])).toBe("x[omb:LONG]y");
    expect(feed(secrets, ["abcdefgh", "ijklmnop!"])).toBe("[omb:LONG]!");
    expect(feed(secrets, ["abcdefgh", "Z"])).toBe("[omb:SHORT]Z");
    expect(feed(secrets, ["abcdefgh"])).toBe("[omb:SHORT]");
  });

  it("releases a held tail that never became a match, on the next chunk and at the end", () => {
    const scrubber = createScrubber([{ ref: "A", value: "abcdefghij" }]);
    expect(scrubber.push(Buffer.from("say abcde")).toString()).toBe("say ");
    expect(scrubber.push(Buffer.from("Z done")).toString()).toBe("abcdeZ done");
    expect(scrubber.push(Buffer.from("abc")).toString()).toBe("");
    expect(scrubber.end().toString()).toBe("abc");
  });

  it("keeps a multi-byte value whole when a chunk ends inside a character", () => {
    const bytes = Buffer.from("token-é-ü-中-value");
    const scrubber = createScrubber([{ ref: "U", value: "token-é-ü-中-value" }]);
    for (let cut = 1; cut < bytes.length; cut++) {
      const first = scrubber.push(bytes.subarray(0, cut));
      const second = scrubber.push(bytes.subarray(cut));
      expect(Buffer.concat([first, second, scrubber.end()]).toString()).toBe("[omb:U]");
    }
  });

  it("passes everything through when there is nothing to hide", () => {
    expect(feed([], ["plain ", "text"])).toBe("plain text");
  });
});
