import { accessSync, chmodSync, constants, copyFileSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const EMPTY_STDIN = { async *[Symbol.asyncIterator]() {} };
/** Longest text kept from a command's output. */
const MAX_OUTPUT = 256 * 1024;

export const ombInstallPath = (home) => join(home, ".local", "bin", "omb");

/** Copies omb to ~/.local/bin/omb, mode 0755, by a temporary file and a rename. A symbolic link already there is the person's own set-up and stays. */
export function copyOmb({ source, home }) {
  const target = ombInstallPath(home);
  let existing = null;
  try { existing = lstatSync(target); } catch { /* not installed yet */ }
  if (existing?.isSymbolicLink()) return { path: target, state: "linked" };
  mkdirSync(join(home, ".local", "bin"), { recursive: true, mode: 0o755 });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    copyFileSync(source, temporary);
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return { path: target, state: existing ? "updated" : "installed" };
}

/** The first `node` on a PATH list. Without one the hook command keeps the bare name, which a shell resolves later: the app's own binary must never stand in. */
export function findNode(searchPath, { exists = (file) => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } } } = {}) {
  for (const dir of String(searchPath ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, "node");
    if (exists(file)) return { path: file, found: true };
  }
  return { path: "node", found: false };
}

/** Loads omb.mjs from a file path. Never a static import: a bundle that inlined omb would run its command line at start. */
export const loadOmb = (file) => import(pathToFileURL(file).href);

const cut = (text) => (text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) : text);

/**
 * Runs one omb command in this process and returns its exit code and JSON envelope. `hide` lists strings (a pairing
 * code) that must never come back in any text. Output is the envelope only: a failed command has `error`, not `data`.
 */
export async function runOmb(omb, argv, { env, home, nodePath, selfPath, hide = [] }) {
  let out = "";
  let err = "";
  const code = await omb.main([...argv, "--json"], {
    env, home, nodePath, selfPath, stdin: EMPTY_STDIN, stdinIsTTY: false,
    stdout: { write: (chunk) => { out = cut(out + String(chunk)); return true; } },
    stderr: { write: (chunk) => { err = cut(err + String(chunk)); return true; } },
  });
  const scrub = (text) => hide.reduce((all, secret) => (secret ? all.split(secret).join("[hidden]") : all), text);
  let envelope = null;
  try { envelope = JSON.parse(out.trim().split("\n").at(-1) ?? ""); } catch { /* no envelope */ }
  return {
    code,
    data: envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : null,
    error: scrub(typeof envelope?.error === "string" ? envelope.error : err.trim()).slice(0, 500) || null,
  };
}
