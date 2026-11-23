import { resolve } from "node:path";

import { shellWords, type ShellWord } from "./shell-words.ts";

/** What this rule takes from the other rules in permission-rules.ts. */
export interface ReadOnlyHooks {
  /** The agent's working directory; a leading `cd` moves it for the rest of the line. */
  cwd: string | undefined;
  /** True when no git setting visible from this directory makes a read run another program. */
  gitConfigSafe(dir: string | undefined): boolean;
  /** True when a file or link is really named like this argument, which has the `APPROVED:` prefix, in `dir` (the directory a
   * leading `cd` moved to), or when that cannot be told. `dir` is undefined when the directory is unknown. */
  approvedExists(dir: string | undefined, argument: string): boolean | Promise<boolean>;
  /** Called when the line is refused for a hidden hazard (unsafe git setting or hook, CDPATH, a real file named `APPROVED:…`) and not for what it says. */
  hazard(): void;
}

export const READ_ONLY_RULE = "read-only-command";
const APPROVED = "APPROVED:";

/** What the shell would substitute, redirect or run in the background. Quotes do not make these safe, so they are refused
 * on the raw text. Globs, braces and `~` only read names, so they are not here; `&&` is split off before this is tested. */
const FORBIDDEN_SYNTAX = /[$`()<>&\\]/;

/** True when the long option `arg` is the whole name or a shortened form of one of `names` (git and GNU tools take both). */
const isLongOptionOf = (arg: string, names: readonly string[]): boolean => {
  if (!arg.startsWith("--")) return false;
  const name = arg.slice(2).split("=")[0]!;
  return name.length > 0 && names.some((full) => full.startsWith(name));
};
const shortCluster = (arg: string, letters: string): boolean => /^-[^-]/.test(arg) && [...letters].some((letter) => arg.slice(1).includes(letter));

type Check = (args: string[]) => boolean;
const anyArg = (args: string[], test: (arg: string) => boolean): boolean => args.some(test);
const positional = (args: string[]): string[] => args.filter((arg) => !arg.startsWith("-"));

const GIT_WRITES = ["output", "ext-diff", "open-files-in-pager", "exec-path", "show-signature"];
const GIT_READ_SUBCOMMANDS = new Set(["diff", "log", "show", "status", "blame", "rev-parse", "ls-files", "ls-tree", "grep", "describe"]);
const GIT_BRANCH_FLAGS = new Set(["-a", "-r", "-v", "-vv", "--all", "--remotes", "--verbose", "--list", "--show-current"]);
const GIT_CONFIG_FIRST = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);
const GIT_CONFIG_FLAGS = new Set(["--local", "--global", "--system", "--show-origin", "--show-scope", "--name-only", "-z", "--null"]);

function gitIsReadOnly(args: string[]): boolean {
  // A flag before the subcommand (-c, -C, --exec-path, --paginate) changes what git runs: refused.
  const sub = args[0];
  if (sub === undefined || sub.startsWith("-")) return false;
  const rest = args.slice(1);
  if (sub === "branch") return rest.every((arg) => GIT_BRANCH_FLAGS.has(arg));
  if (sub === "remote") return rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose"));
  if (sub === "config") return GIT_CONFIG_FIRST.has(rest[0] ?? "") && rest.slice(1).every((arg) => !arg.startsWith("-") || GIT_CONFIG_FLAGS.has(arg));
  if (!GIT_READ_SUBCOMMANDS.has(sub)) return false;
  if (anyArg(rest, (arg) => isLongOptionOf(arg, GIT_WRITES))) return false;
  // `-o` writes the output of `diff`, `log` and `show` to a file; `grep -O` opens a pager program. Both may sit inside a
  // cluster of short flags, as in `-nO`.
  if ((sub === "diff" || sub === "log" || sub === "show") && anyArg(rest, (arg) => shortCluster(arg, "o"))) return false;
  if (sub === "grep" && anyArg(rest, (arg) => shortCluster(arg, "O"))) return false;
  return true;
}

const FIND_UNSAFE = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls"]);

const PROGRAMS: ReadonlyMap<string, Check> = new Map(Object.entries({
  git: gitIsReadOnly,
  ls: () => true,
  cat: () => true,
  pwd: () => true,
  stat: () => true,
  du: () => true,
  df: () => true,
  which: () => true,
  realpath: () => true,
  basename: () => true,
  dirname: () => true,
  wc: () => true,
  cut: () => true,
  tr: () => true,
  jq: () => true,
  diff: () => true,
  cmp: () => true,
  echo: () => true,
  // `-o` and `-R` write files.
  tree: (args) => !anyArg(args, (arg) => shortCluster(arg, "oR")),
  file: (args) => !anyArg(args, (arg) => shortCluster(arg, "C") || isLongOptionOf(arg, ["compile"])),
  head: () => true,
  tail: (args) => !anyArg(args, (arg) => shortCluster(arg, "fF") || isLongOptionOf(arg, ["follow", "retry"])),
  sort: (args) => !anyArg(args, (arg) => shortCluster(arg, "o") || isLongOptionOf(arg, ["output", "compress-program"])),
  // `uniq in out` writes the second file; a glob could grow into two.
  uniq: (args) => positional(args).length <= 1,
  grep: (args) => !anyArg(args, (arg) => shortCluster(arg, "f") || isLongOptionOf(arg, ["file"])),
  rg: (args) => !anyArg(args, (arg) => shortCluster(arg, "fz") || isLongOptionOf(arg, ["pre", "pre-glob", "file", "hostname-bin", "search-zip"])),
  find: (args) => !anyArg(args, (arg) => FIND_UNSAFE.has(arg) || arg.startsWith("-fprint")),
}));

/** True when a word is safe to hand to the program: no unquoted brace, and a glob starts with a plain letter, digit or path mark,
 * so that no file can turn into an option when the shell expands it. */
const wordIsPlain = (word: ShellWord): boolean => !word.brace && (!word.glob || !/^[-*?[]/.test(word.text));

async function stepIsReadOnly(tokens: ShellWord[], hooks: ReadOnlyHooks, dir: string | undefined): Promise<boolean> {
  if (!tokens.every(wordIsPlain)) return false;
  const texts = tokens.map((token) => token.text);
  for (const arg of texts) {
    if (arg.startsWith(APPROVED) && (await hooks.approvedExists(dir, arg))) {
      hooks.hazard();
      return false;
    }
  }
  const [tool, ...args] = texts as [string, ...string[]];
  const check = PROGRAMS.get(tool);
  // A program that is not listed is not read-only here.
  if (!check || !check(args)) return false;
  // `uniq` takes one file and no glob, which could expand into a second one.
  if (tool === "uniq" && tokens.slice(1).some((token) => token.glob)) return false;
  if (tool === "git" && !hooks.gitConfigSafe(dir)) {
    hooks.hazard();
    return false;
  }
  return true;
}

async function pipelineIsReadOnly(segment: string, hooks: ReadOnlyHooks, dir: string | undefined): Promise<boolean> {
  const steps = segment.split("|").map((part) => shellWords(part));
  for (const tokens of steps) {
    if (!tokens?.length || !(await stepIsReadOnly(tokens, hooks, dir))) return false;
  }
  return true;
}

/**
 * True when the whole line only reads: pipelines of read-only programs, joined by `&&`, with an optional `cd <dir>` first.
 * Semicolons, newlines, redirects, substitutions, `||` and background jobs are refused, and so is any option that writes a
 * file or runs another program.
 */
export async function readOnlyCommand(command: string, hooks: ReadOnlyHooks): Promise<boolean> {
  // Only a space and a tab are white space here; a line feed, a vertical tab, a no-break space and the like are refused.
  if (/[;]|[^\S \t]/.test(command)) return false;
  const segments = command.split("&&");
  if (segments.some((segment) => FORBIDDEN_SYNTAX.test(segment))) return false;
  let first = 0;
  let dir = hooks.cwd;
  const leading = shellWords(segments[0]!);
  if (segments.length > 1 && leading?.length === 2 && leading[0]!.text === "cd" && !leading[1]!.glob && !leading[1]!.brace && !leading[1]!.text.startsWith("-")) {
    first = 1;
    const target = leading[1]!.text;
    // With CDPATH set, a relative `cd` may go somewhere else than the name says.
    if (!target.startsWith("/") && !target.startsWith("~") && process.env.CDPATH) {
      hooks.hazard();
      return false;
    }
    // A `~` or a relative path with no known start leaves the directory unknown, which git steps refuse.
    dir = target.startsWith("~") || (!target.startsWith("/") && !hooks.cwd) ? undefined : resolve(hooks.cwd ?? "/", target);
  }
  for (const segment of segments.slice(first)) {
    if (!(await pipelineIsReadOnly(segment, hooks, dir))) return false;
  }
  return true;
}
