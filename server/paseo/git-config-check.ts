import { execFileSync } from "node:child_process";

/** The settings that make git run another program during a read: a pager, a diff or text filter, a file monitor, a hook folder,
 * a signing program or an editor. Keys are matched as git stores them (section and variable in lower case). */
const RUNNING_SETTINGS =
  "^(core\\.fsmonitor|core\\.pager|core\\.hookspath|diff\\.external|diff\\..+\\.(textconv|command)|filter\\..+\\.(clean|smudge|process)|gpg\\.program|gpg\\..+\\.program|pager\\..+|interactive\\.difffilter|sequence\\.editor|core\\.editor)$";
const TIMEOUT_MS = 1_500;
const CACHE_MS = 60_000;

const cache = new Map<string, { safe: boolean; until: number }>();

/**
 * True when no git setting visible from `dir` names a program git would run for a read. Git is run without a shell and with
 * a short timeout; exit status 1 means no such setting. A match, any other status, a timeout and a missing git all give false.
 * The answer is kept for a minute for each directory.
 */
export function gitConfigRunsNoProgram(dir: string | undefined, now: () => number = Date.now): boolean {
  if (!dir) return false;
  const known = cache.get(dir);
  if (known && known.until > now()) return known.safe;
  let safe = false;
  try {
    execFileSync("git", ["config", "--get-regexp", RUNNING_SETTINGS], { cwd: dir, timeout: TIMEOUT_MS, stdio: "ignore" });
  } catch (error) {
    safe = (error as { status?: unknown }).status === 1;
  }
  cache.set(dir, { safe, until: now() + CACHE_MS });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return safe;
}

/** For tests. */
export function forgetGitConfigAnswers(): void {
  cache.clear();
}
