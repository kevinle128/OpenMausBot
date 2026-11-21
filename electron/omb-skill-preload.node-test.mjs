import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const PRELOAD = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const LOCAL = "http://127.0.0.1:8799";

/** `verified`: what main answers to the page check (the main window's saved-server or home page). */
function preload(origin, { verified = false, activation = false } = {}) {
  let bridge;
  const invoked = [];
  vm.runInNewContext(PRELOAD, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${LOCAL}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: activation } }, TextEncoder, localStorage: { getItem: () => null }, queueMicrotask,
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, sendSync: (channel) => (channel === "omb-skill:page" ? verified : null), invoke: (...args) => { invoked.push(args); return Promise.resolve({ rows: [] }); } } }),
  });
  return { bridge, invoked };
}

test("the install bridge is on this computer's own page, and on a remote page only when main verified it", () => {
  assert.ok(preload(LOCAL).bridge.ombSkill);
  assert.ok(preload("https://mini.example.com", { verified: true }).bridge.ombSkill, "a saved server or home page of the main window");
  assert.equal(preload("https://unknown.example.org").bridge.ombSkill, undefined, "any other origin");
});

test("on a remote page an install needs a click, and only harness ids and a code are sent", async () => {
  const quiet = preload("https://mini.example.com", { verified: true });
  await assert.rejects(() => quiet.bridge.ombSkill.install(["codex"]), /Choose Install/);
  assert.deepEqual(quiet.invoked, []);
  const clicked = preload("https://mini.example.com", { verified: true, activation: true });
  await clicked.bridge.ombSkill.install(["codex"], "ABCD-EFGH-JKLM");
  assert.deepEqual(clicked.invoked, [["omb-skill:install", ["codex"], "ABCD-EFGH-JKLM"]]);
});
