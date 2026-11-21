import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import baseTest from "node:test";

// omb supports macOS and Linux only: file modes and a shell `node` stand-in do not hold on Windows.
const test = (name, run) => baseTest(name, { skip: process.platform === "win32" && "omb supports macOS and Linux only" }, run);
import * as realOmb from "../bin/omb.mjs";
import { installOmbSkill } from "./omb-skill-main.mjs";

const CODE = "ABCD-EFGH-JKLM";
const SERVER = "http://127.0.0.1:8799";

/** Real omb for `skill`, scripted answers for `status` and `pair` (no server runs here). */
function fixture({ status = null, pairFails = false, platform = "darwin", origin = SERVER, remote = null, allowed = () => true, isLocal = () => true, focused = () => true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "omb-skill-main-"));
  const bin = path.join(home, "node-bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "node"), "#!/bin/sh\n");
  chmodSync(path.join(bin, "node"), 0o755);
  const calls = [];
  const handlers = new Map(), listeners = new Map();
  let paired = status;
  const load = async () => ({
    HARNESSES: realOmb.HARNESSES,
    main: async (argv, overrides) => {
      calls.push(argv);
      if (argv[0] === "status") {
        overrides.stdout.write(`${JSON.stringify({ schema_version: 1, kind: "status", data: paired ?? undefined, ...(paired ? {} : { error: "not paired", error_code: "x", exit_code: 5 }) })}\n`);
        return paired ? 0 : 5;
      }
      if (argv[0] === "pair") {
        if (pairFails) { overrides.stdout.write(`${JSON.stringify({ schema_version: 1, error: `the code ${argv[1]} was refused`, error_code: "x", exit_code: 6 })}\n`); return 6; }
        paired = { server: argv[3], tokenAccepted: true };
        overrides.stdout.write(`${JSON.stringify({ schema_version: 1, kind: "pair", data: {} })}\n`);
        return 0;
      }
      return realOmb.main(argv, overrides);
    },
  });
  installOmbSkill({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: (channel, listener) => listeners.set(channel, listener) }, guard: (_channel, handler) => handler,
    serverOrigin: () => origin, remoteServer: () => remote, allowed, isLocal, focused, isPackaged: false, resourcesPath: "/nowhere", platform, home, env: { PATH: bin }, load, searchPath: async () => bin,
  });
  return { handlers, listeners, home, bin, calls, state: () => handlers.get("omb-skill:state")({}), install: (...args) => handlers.get("omb-skill:install")({}, ...args), done: () => rmSync(home, { recursive: true, force: true }) };
}

test("state lists the harnesses and whether this computer is paired with the server", async () => {
  const t = fixture();
  try {
    const state = await t.state();
    assert.equal(state.available, true);
    assert.equal(state.paired, false);
    assert.equal(state.rows.length, 21);
    assert.equal(state.rows.find((row) => row.harness === "codex").status, "missing");
  } finally { t.done(); }
});

test("an unpaired computer without a code gets needsPairing and nothing is written", async () => {
  const t = fixture();
  try {
    assert.deepEqual(await t.install(["codex"]), { needsPairing: true, rows: [], notes: [] });
    assert.equal(existsSync(path.join(t.home, ".local", "bin", "omb")), false);
    assert.equal(existsSync(path.join(t.home, ".agents")), false);
  } finally { t.done(); }
});

test("a code pairs this computer to the server in use, then omb and the skill are installed, and the hook uses node and the installed copy", async () => {
  const t = fixture();
  try {
    const result = await t.install(["claudeAgent", "codex"], CODE);
    assert.deepEqual(t.calls.find((argv) => argv[0] === "pair"), ["pair", CODE, "--server", SERVER, "--json"]);
    assert.deepEqual(result.rows.map((row) => [row.harness, row.status]), [["claudeAgent", "installed"], ["codex", "installed"]]);
    const copy = path.join(t.home, ".local", "bin", "omb");
    assert.equal(result.command, copy);
    assert.equal(statSync(copy).mode & 0o777, 0o755);
    const hook = JSON.parse(readFileSync(path.join(t.home, ".claude", "settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
    assert.equal(hook, `"${path.join(t.bin, "node")}" "${copy}" hook claude-pretooluse`);
    const again = await t.install(["codex"]);
    assert.equal(again.rows[0].status, "unchanged");
  } finally { t.done(); }
});

test("a paired computer is not asked to pair again", async () => {
  const t = fixture({ status: { server: SERVER, tokenAccepted: true } });
  try {
    assert.equal((await t.state()).paired, true);
    const result = await t.install(["codex"]);
    assert.equal(result.rows[0].status, "installed");
    assert.equal(t.calls.some((argv) => argv[0] === "pair"), false);
  } finally { t.done(); }
});

test("a pairing with another server stays, and the person is told", async () => {
  const t = fixture({ status: { server: "https://other.example.com", tokenAccepted: true } });
  try {
    const result = await t.install(["codex"], CODE);
    assert.deepEqual(result.notes, [{ key: "pairedElsewhere", server: "https://other.example.com" }]);
    assert.equal(t.calls.some((argv) => argv[0] === "pair"), false);
    assert.equal(result.rows[0].status, "installed");
  } finally { t.done(); }
});

test("a pairing with another server stays even when that server does not answer, and a moved loopback port pairs again", async () => {
  const away = fixture({ status: { server: "https://other.example.com", tokenAccepted: false } });
  try {
    const result = await away.install(["codex"], CODE);
    assert.deepEqual(result.notes, [{ key: "pairedElsewhere", server: "https://other.example.com" }]);
    assert.equal(away.calls.some((argv) => argv[0] === "pair"), false);
  } finally { away.done(); }
  const moved = fixture({ status: { server: "http://127.0.0.1:8800", tokenAccepted: true } });
  try {
    const result = await moved.install(["codex"], CODE);
    assert.deepEqual(result.notes, []);
    assert.deepEqual(moved.calls.find((argv) => argv[0] === "pair"), ["pair", CODE, "--server", SERVER, "--json"]);
  } finally { moved.done(); }
});

test("a refused code returns an error without the code in it, and installs nothing", async () => {
  const t = fixture({ pairFails: true });
  try {
    const result = await t.install(["codex"], CODE);
    assert.deepEqual(result.rows, []);
    assert.ok(result.error && !result.error.includes(CODE), result.error);
    assert.equal(existsSync(path.join(t.home, ".local", "bin", "omb")), false);
  } finally { t.done(); }
});

test("it refuses ids and codes of a wrong shape, and is not offered on Windows or without a server", async () => {
  const t = fixture();
  try {
    for (const ids of [[], "codex", ["../x"], [3], Array(41).fill("a")]) await assert.rejects(() => t.install(ids));
    await assert.rejects(() => t.install(["codex"], "bad code; rm -rf"));
    await assert.rejects(() => t.install(["codex"], 12));
  } finally { t.done(); }
  const windows = fixture({ platform: "win32" });
  try {
    assert.deepEqual(await windows.state(), { available: false, paired: false, rows: [] });
    await assert.rejects(() => windows.install(["codex"], CODE));
  } finally { windows.done(); }
  const none = fixture({ origin: null });
  try { assert.equal((await none.state()).available, false); } finally { none.done(); }
});

test("connected to another server: the skill installs here, no pairing is tried, and the next step is shown when unpaired", async () => {
  const REMOTE = "https://mini.example.com";
  const t = fixture({ origin: null, remote: REMOTE });
  try {
    assert.equal((await t.state()).available, true);
    const result = await t.install(["claudeAgent", "codex"], CODE);
    assert.equal(result.needsPairing, undefined);
    assert.equal(t.calls.some((argv) => argv[0] === "pair"), false);
    assert.deepEqual(result.rows.map((row) => [row.harness, row.status]), [["claudeAgent", "installed"], ["codex", "installed"]]);
    assert.deepEqual(result.notes, [{ key: "pairNeeded", server: REMOTE }]);
    assert.equal(statSync(path.join(t.home, ".local", "bin", "omb")).mode & 0o777, 0o755);
  } finally { t.done(); }
  const paired = fixture({ origin: null, remote: REMOTE, status: { server: "https://elsewhere.example.com", tokenAccepted: true } });
  try {
    const result = await paired.install(["codex"]);
    assert.deepEqual(result.notes, []);
    assert.equal(paired.calls.some((argv) => argv[0] === "pair"), false);
    assert.equal((await paired.state()).paired, true);
  } finally { paired.done(); }
});

const mini = { senderFrame: { url: "https://mini.example.com/chat" } };

test("a page the main window shows from another server installs on this computer, never pairs, and names that server's own origin", async () => {
  const t = fixture({ origin: SERVER, remote: "https://companion.example.net", isLocal: () => false });
  try {
    const handler = (channel) => t.handlers.get(channel);
    const result = await handler("omb-skill:install")(mini, ["codex"], CODE);
    assert.equal(t.calls.some((argv) => argv[0] === "pair"), false);
    assert.equal(result.rows[0].status, "installed");
    assert.deepEqual(result.notes, [{ key: "pairNeeded", server: "https://mini.example.com" }]);
    assert.equal((await handler("omb-skill:state")(mini)).available, true);
  } finally { t.done(); }
});

test("an unverified sender is refused on both channels and in the page check, and an install needs the focused window", async () => {
  const t = fixture({ allowed: () => false });
  try {
    await assert.rejects(async () => t.handlers.get("omb-skill:state")({}), /only available in the main window/);
    await assert.rejects(async () => t.handlers.get("omb-skill:install")({}, ["codex"]), /only available in the main window/);
    const reply = {}; t.listeners.get("omb-skill:page")({ ...reply, set returnValue(value) { reply.value = value; } });
    assert.equal(reply.value, false);
    assert.equal(existsSync(path.join(t.home, ".local", "bin", "omb")), false);
  } finally { t.done(); }
  const background = fixture({ focused: () => false });
  try {
    await assert.rejects(async () => background.handlers.get("omb-skill:install")({}, ["codex"], CODE), /focused window/);
    assert.equal((await background.handlers.get("omb-skill:state")({})).available, true);
    assert.equal(existsSync(path.join(background.home, ".local", "bin", "omb")), false);
  } finally { background.done(); }
});

test("a harness the page names that omb does not know is refused", async () => {
  const t = fixture({ status: { server: SERVER, tokenAccepted: true } });
  try { await assert.rejects(() => t.install(["notAHarness"]), /from the list/); } finally { t.done(); }
});
