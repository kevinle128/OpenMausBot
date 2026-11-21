import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import baseTest from "node:test";

// omb supports macOS and Linux only: file modes and a shell `node` stand-in do not hold on Windows.
const test = (name, run) => baseTest(name, { skip: process.platform === "win32" && "omb supports macOS and Linux only" }, run);
import { installOmbSkill } from "./omb-skill-main.mjs";

test("the server bundle step puts omb.mjs where the packaged app and the server look for it", async () => {
  const builder = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.ok(builder.includes("  - from: dist-server\n    to: server\n"));
  const bundle = readFileSync(new URL("../scripts/bundle-server.mjs", import.meta.url), "utf8");
  assert.ok(bundle.includes('copyFileSync(join(root, "bin", "omb.mjs"), join(root, "dist-server", "bin", "omb.mjs"))'));
  const loaded = [];
  const handlers = new Map();
  installOmbSkill({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on() {} }, allowed: () => true, isLocal: () => true, serverOrigin: () => "http://127.0.0.1:8799",
    isPackaged: true, resourcesPath: "/Applications/App.app/Contents/Resources", platform: "darwin", home: "/nonexistent-home", env: {}, searchPath: async () => "",
    load: async (file) => { loaded.push(file); return { main: async (_argv, overrides) => { overrides.stdout.write("{}\n"); return 5; } }; },
  });
  await handlers.get("omb-skill:state")({});
  assert.equal(loaded[0], "/Applications/App.app/Contents/Resources/server/bin/omb.mjs");
});

test("the omb command imports Node's own modules only, so one copied file runs alone", () => {
  const source = readFileSync(new URL("../bin/omb.mjs", import.meta.url), "utf8");
  const sources = [...source.matchAll(/from "([^"]+)";/g)].map((found) => found[1]);
  assert.ok(sources.length > 0 && sources.every((name) => name.startsWith("node:")), sources.join(", "));
});
