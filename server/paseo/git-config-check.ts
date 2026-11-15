import { execFileSync } from "node:child_process";

/** The settings that make git run another program during a read: a pager, a diff or text filter, a file monitor, a signing
 * program or an editor. Hooks are not here: the read-only subcommands never run them. Keys are matched as git stores them (section and variable in lower case). */
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
    const found = execFileSync("git", ["config", "--get-regexp", RUNNING_SETTINGS], {
      cwd: dir, timeout: TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    // Each line is `key value`. The values are compared and never logged.
    safe = found.split("\n").filter(Boolean).every((line) => {
      const at = line.indexOf(" ");
      return at > 0 && STANDARD_LFS.get(line.slice(0, at)) === line.slice(at + 1).trim();
    });
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
