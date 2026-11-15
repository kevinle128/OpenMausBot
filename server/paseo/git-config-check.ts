import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";

/** The settings that make git run another program during a read: a pager, a diff or text filter, a file monitor, a signing
 * program or an editor. Keys are matched as git stores them (section and variable in lower case). */
const RUNNING_SETTINGS =
  "^(core\\.fsmonitor|core\\.pager|diff\\.external|diff\\..+\\.(textconv|command)|filter\\..+\\.(clean|smudge|process)|gpg\\.program|gpg\\..+\\.program|pager\\..+|interactive\\.difffilter|sequence\\.editor|core\\.editor)$";
/** The standard git-lfs filter settings, which only run `git-lfs`; any other value of these keys is refused. */
const STANDARD_LFS = new Map([
  ["filter.lfs.clean", "git-lfs clean -- %f"],
  ["filter.lfs.smudge", "git-lfs smudge -- %f"],
  ["filter.lfs.process", "git-lfs filter-process"],
]);
const TIMEOUT_MS = 1_500;
const CACHE_MS = 60_000;
const MAX_SUBMODULES = 20;
/** The index listing of a large repository is long; a listing past this is an error, so the answer is false. */
const MAX_OUTPUT = 64 * 1024 * 1024;
/** `git status` and `git diff` run this hook after they refresh the index. */
const INDEX_HOOK = "hooks/post-index-change";

const cache = new Map<string, { safe: boolean; until: number }>();

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, timeout: TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAX_OUTPUT });
}

/** True when git exits 1, its "nothing matched" status; any other failure is thrown on. */
function gitOrNothing(dir: string, args: string[]): string {
  try {
    return git(dir, args);
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return "";
    throw error;
  }
}

/** One repository: no setting runs a program, except the standard git-lfs filter, and no index hook exists. Throws on any error. */
function repositoryIsQuiet(dir: string): boolean {
  // With -z each entry is `key`, a newline, the value and a NUL, so a value holding a newline cannot pass for another one.
  const found = gitOrNothing(dir, ["config", "-z", "--get-regexp", RUNNING_SETTINGS]);
  for (const entry of found.split("\0").filter(Boolean)) {
    const at = entry.indexOf("\n");
    if (at <= 0 || STANDARD_LFS.get(entry.slice(0, at)) !== entry.slice(at + 1).trim()) return false;
  }
  const hook = git(dir, ["rev-parse", "--git-path", INDEX_HOOK]).trim();
  if (!hook) throw new Error("no hook path");
  try {
    lstatSync(resolve(dir, hook));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Every checked-out submodule below `top`, found as git finds them: by the gitlink entries (mode 160000) of the index, not by
 * the `.gitmodules` file, which can be missing. Each repository is checked once; too many or any git failure gives false. */
function submodulesAreQuiet(top: string, budget: { left: number }): boolean {
  const listed = git(top, ["ls-files", "-s", "-z"]);
  for (const entry of listed.split("\0").filter(Boolean)) {
    // `<mode> <object> <stage>` and a tab, then the path.
    const tab = entry.indexOf("\t");
    if (tab < 0 || !entry.startsWith("160000 ")) continue;
    budget.left -= 1;
    if (budget.left < 0) return false;
    const path = entry.slice(tab + 1);
    if (!path || path.startsWith("/") || path.split("/").includes("..")) return false;
    const sub = join(top, path);
    // A submodule that is not checked out has no repository there and runs nothing.
    try {
      lstatSync(join(sub, ".git"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
    if (!repositoryIsQuiet(sub) || !submodulesAreQuiet(sub, budget)) return false;
  }
  return true;
}

/**
 * True when reading in `dir` would run no program of git's: no such setting in the repository or in any checked-out
 * submodule (`git status`, `git diff` and `git grep` use each one's own config), and no `post-index-change` hook. Git is run
 * without a shell and with a short timeout. A match, an error, a timeout, a missing git and more than 20 submodules all give
 * false. The answer is kept for a minute for each directory. It reads the environment of this process, so it assumes the
 * agent runs as the same user with no extra GIT_* variables.
 */
export function gitConfigRunsNoProgram(dir: string | undefined, now: () => number = Date.now): boolean {
  if (!dir) return false;
  const known = cache.get(dir);
  if (known && known.until > now()) return known.safe;
  let safe = false;
  try {
    const top = git(dir, ["rev-parse", "--show-toplevel"]).trim();
    safe = repositoryIsQuiet(dir) && (top === "" || submodulesAreQuiet(top, { left: MAX_SUBMODULES }));
  } catch {
    safe = false;
  }
  cache.set(dir, { safe, until: now() + CACHE_MS });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return safe;
}

/** For tests. */
export function forgetGitConfigAnswers(): void {
  cache.clear();
}
