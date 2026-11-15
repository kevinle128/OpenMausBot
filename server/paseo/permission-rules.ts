import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { PaseoPermissionRequest } from "./connection.ts";
import { READ_ONLY_RULE, readOnlyCommand } from "./read-only-commands.ts";
import { words } from "./shell-words.ts";

export type PermissionVerdict = "allow" | "ask" | "ambiguous";

export interface PermissionDecision {
  verdict: PermissionVerdict;
  /** A fixed id, safe to log: it never carries the command or file name. */
  rule: string;
}

/** What a request wants to do, as far as the rules can read it. */
export type PermissionTarget = { kind: "command"; command: string } | { kind: "file"; filePath: string };

/** What the rules need from the machine: whether a path is a plain file whose real name is still an env file. */
export interface PermissionContext {
  /** The agent's working directory, for a path that is not absolute. */
  cwd?: string;
  /** Replaced by tests that do not want a real file system. */
  envFile?: (cwd: string | undefined, filePath: string) => boolean;
  /** Replaced by tests. Whether a path is an existing regular file, whatever its name. */
  /** Whether OpenMausBot owns this `ak` ref (a Vault secret kept to the Paseo bot). Without it no `ak secrets run` is allowed. */
  ownsRef?: (ref: string) => boolean;
  regularFile?: (cwd: string | undefined, filePath: string) => boolean;
}

/** The hook of AgentKit puts this before a path it let the person approve once. */
export const APPROVED_PREFIX = "APPROVED:";

const READ_SUBCOMMANDS = new Set(["get", "list", "search", "describe", "request", "resolve", "audit", "grants"]);
const WRITE_SUBCOMMANDS = new Set([
  "set", "delete", "rotate", "grant", "approve", "revoke", "import-env", "export", "sync", "trust", "alias", "annotate", "recovery",
]);

/** Flags every read-only `ak secrets` subcommand takes. `--reveal`, `-y`, `--backend`, `--exec`, `--env` and
 * `--unlock-with-recovery` are not here: they print a value, answer a prompt or change where `ak` reads. */
const AK_COMMON_FLAGS = new Set(["--json", "--no-interactive", "-q", "--quiet"]);
/** Per subcommand: the flags that narrow it and take a value, and how many plain words it takes (null: any number). */
const AK_SUBCOMMANDS: Record<string, { valueFlags: string[]; words: number | null }> = {
  get: { valueFlags: [], words: 1 },
  describe: { valueFlags: [], words: 1 },
  list: { valueFlags: [], words: 0 },
  grants: { valueFlags: [], words: 0 },
  search: { valueFlags: ["--account", "--environment", "--kind", "--project", "--provider", "--sensitivity", "--tag"], words: null },
  request: { valueFlags: ["--project", "--purpose"], words: 1 },
  resolve: { valueFlags: ["--project", "--purpose"], words: 1 },
  audit: { valueFlags: ["--agent", "--cursor", "--decision", "--limit", "--secret", "--since", "--source"], words: 0 },
};

/** Flags that only change how a file is shown. `rg --pre` and `grep -f` run or load other things, so they are not here;
 * `less` and `source` are not readers at all, because they run what they read or can open a shell. */
const SAFE_FLAGS: Record<string, RegExp> = {
  cat: /^-[nAEbsTv]+$/,
  head: /^-[nqvc]+$/,
  tail: /^-[nqvc]+$/,
  grep: /^-[invwFEclHhsq]+$/,
  rg: /^-[invwFclHhsq]+$/,
};
const ENV_FILE_READERS = new Set(Object.keys(SAFE_FLAGS));

/** The only programs that may follow a pipe after an allowed step. They read standard input and nothing else: none takes
 * a file, writes a file or runs a program, because `sort -o`, `uniq in out`, `grep -f` and `rg --pre` are outside the flag lists. */
interface FilterSpec {
  flag: RegExp;
  /** Flags whose next word is their value. */
  valueFlags?: string[];
  /** Fewest and most plain words: a pattern or a character set, never a file. */
  words: [number, number];
}
const LINE_COUNT_FLAG = /^-(?:[qv]+|\d+|[nc]\d+)$/;
const PIPE_FILTERS: Record<string, FilterSpec> = {
  head: { flag: LINE_COUNT_FLAG, valueFlags: ["-n", "-c"], words: [0, 0] },
  tail: { flag: LINE_COUNT_FLAG, valueFlags: ["-n", "-c"], words: [0, 0] },
  wc: { flag: /^-[lwcm]+$/, words: [0, 0] },
  sort: { flag: /^-[rnufb]+$/, words: [0, 0] },
  uniq: { flag: /^-[cdui]+$/, words: [0, 0] },
  cut: { flag: /^-[dfcb].+$/, valueFlags: ["-d", "-f", "-c", "-b"], words: [0, 0] },
  tr: { flag: /^-[dsc]+$/, words: [1, 2] },
  grep: { flag: SAFE_FLAGS.grep!, words: [1, 1] },
  rg: { flag: SAFE_FLAGS.rg!, words: [1, 1] },
};

/** Characters that start a substitution, a subshell, a background job, a redirect or a glob, or that escape the next
 * one. They are refused on the raw text before any quote-aware reading, because `$(...)` and backticks run inside
 * double quotes. `&&` and `||` fall here or leave an empty step, so they are never read as a join of safe steps. */
const SHELL_SYNTAX = /[$`()<>&*?[\]{}~\\]/;
const SEPARATORS = /([|;\n\r])/;
/** The tools whose `input.command` is a shell command. Another tool with a `command` field is not one. */
const SHELL_TOOLS = new Set(["bash", "shell", "exec_command"]);

export function isEnvFilePath(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  return base === ".env" || /^\.env\..+/.test(base);
}

/** The real path of a plain file after every link is followed. A pipe, a directory and a missing file give null. */
function realRegularFile(cwd: string | undefined, filePath: string): string | null {
  if (!isAbsolute(filePath) && !cwd) return null;
  try {
    const real = realpathSync(resolve(cwd ?? "/", filePath));
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** True when anything (a file, a link, a pipe) is named exactly like this path, or when that cannot be told. */
function literalExists(cwd: string | undefined, filePath: string): boolean {
  if (!isAbsolute(filePath) && !cwd) return true;
  try {
    lstatSync(resolve(cwd ?? "/", filePath));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** True for an existing regular file, whatever its name. */
export function isRegularFile(cwd: string | undefined, filePath: string): boolean {
  return realRegularFile(cwd, filePath) !== null;
}

/** True for a plain file whose real path, after every link is followed, is still named like an env file. A link to
 * a file with another name, a pipe, a directory and a missing file are all refused. Any place on disk is fine. */
export function isRealEnvFile(cwd: string | undefined, filePath: string): boolean {
  const real = realRegularFile(cwd, filePath);
  return real !== null && isEnvFilePath(real);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The target from the normalized detail, else from the raw tool input a provider left unnormalized. */
export function permissionTarget(request: Pick<PaseoPermissionRequest, "detail" | "input" | "name">): PermissionTarget | null {
  const detail = request.detail;
  if (detail?.type === "shell") {
    const command = text(detail.command);
    return command ? { kind: "command", command } : null;
  }
  if (detail?.type === "read") {
    const filePath = text(detail.filePath);
    return filePath ? { kind: "file", filePath } : null;
  }
  if (detail && detail.type !== "unknown" && detail.type !== "plain_text") return null;
  const input = request.input as Record<string, unknown> | undefined;
  const command = SHELL_TOOLS.has(request.name.toLowerCase()) ? text(input?.command) : undefined;
  if (command) return { kind: "command", command };
  if (/^read$/i.test(request.name)) {
    const filePath = text(input?.file_path) ?? text(input?.filePath) ?? text(input?.path);
    if (filePath) return { kind: "file", filePath };
  }
  return null;
}

type Step = { kind: "allow"; rule: string } | { kind: "filter" } | { kind: "ask"; rule: string };

function readsOnlyEnvFiles(tool: string, args: string[], context: PermissionContext): boolean {
  const safe = SAFE_FLAGS[tool]!;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!safe.test(arg)) return false;
    } else if (!(/^\d+$/.test(arg) && (tool === "head" || tool === "tail"))) {
      operands.push(arg);
    }
  }
  const files = tool === "grep" || tool === "rg" ? operands.slice(1) : operands;
  const envFile = context.envFile ?? isRealEnvFile;
  const regularFile = context.regularFile ?? isRegularFile;
  // A path the person approved once with the hook of AgentKit may be any regular file; every other path must be an env file.
  return files.length > 0 && files.every((file) => {
    // The shell opens the literal argument, so a file or link really named like that must not slip through the prefix.
    if (file.startsWith(APPROVED_PREFIX)) return !literalExists(context.cwd, file) && regularFile(context.cwd, file.slice(APPROVED_PREFIX.length));
    return isEnvFilePath(file) && envFile(context.cwd, file);
  });
}

/** True when every flag is a common one or a narrowing flag of the subcommand, and the plain words fit. */
function akFlagsAreSafe(sub: string, args: string[]): boolean {
  const spec = AK_SUBCOMMANDS[sub];
  if (!spec) return false;
  let plain = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      plain += 1;
      continue;
    }
    if (AK_COMMON_FLAGS.has(arg)) continue;
    const [name, ...inline] = arg.split("=");
    if (!spec.valueFlags.includes(name!)) return false;
    if (inline.length > 0) {
      if (inline.join("=").startsWith("-")) return false;
    } else {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) return false;
      i += 1;
    }
  }
  return spec.words === null || plain === spec.words;
}

function isPipeFilter(tool: string, args: string[]): boolean {
  const spec = PIPE_FILTERS[tool];
  if (!spec) return false;
  let plain = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      plain += 1;
    } else if (spec.valueFlags?.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || (value.startsWith("-") && !/^-\d+$/.test(value))) return false;
      i += 1;
    } else if (!spec.flag.test(arg)) {
      return false;
    }
  }
  return plain >= spec.words[0] && plain <= spec.words[1];
}

const RUN_RULE = "ak-secrets-run-owned-ref";
const RUN_VALUE_FLAGS = new Set(["--purpose", "--project", "--session"]);

/** True for `ak secrets run` with only known flags, at least one `--env VAR=REF`, every REF owned, and a program after `--`. */
function akRunIsOwned(args: string[], context: PermissionContext): boolean {
  if (!context.ownsRef) return false;
  const refs: string[] = [];
  let i = 0;
  for (; i < args.length && args[i] !== "--"; i += 1) {
    const arg = args[i]!;
    if (AK_COMMON_FLAGS.has(arg)) continue;
    const [name, ...inline] = arg.split("=");
    if (name === "--env") {
      const pair = inline.length > 0 ? inline.join("=") : args[++i];
      const at = pair?.indexOf("=") ?? -1;
      if (!pair || at < 1 || at === pair.length - 1) return false;
      refs.push(pair.slice(at + 1));
    } else if (RUN_VALUE_FLAGS.has(name!)) {
      const value = inline.length > 0 ? inline.join("=") : args[++i];
      if (value === undefined || value.startsWith("-")) return false;
    } else {
      return false;
    }
  }
  return args[i] === "--" && i + 1 < args.length && refs.length > 0 && refs.every((ref) => context.ownsRef!(ref));
}

/** One command with no pipe or separator. */
function classifyStep(tokens: string[], context: PermissionContext): Step {
  const [tool, ...args] = tokens as [string, ...string[]];
  if (tool === "ak" && args[0] === "secrets") {
    const sub = args[1] ?? "";
    if (READ_SUBCOMMANDS.has(sub)) {
      return akFlagsAreSafe(sub, args.slice(2)) ? { kind: "allow", rule: "ak-secrets-read" } : { kind: "ask", rule: "ak-secrets-flags" };
    }
    if (sub === "run") return akRunIsOwned(args.slice(2), context) ? { kind: "allow", rule: RUN_RULE } : { kind: "ask", rule: "ak-secrets-run" };
    return { kind: "ask", rule: WRITE_SUBCOMMANDS.has(sub) ? "ak-secrets-write" : "ak-secrets-unknown" };
  }
  if (ENV_FILE_READERS.has(tool) && readsOnlyEnvFiles(tool, args, context)) {
    return { kind: "allow", rule: args.some((arg) => arg.startsWith(APPROVED_PREFIX)) ? "approved-file-read-command" : "env-file-read-command" };
  }
  if (isPipeFilter(tool, args)) return { kind: "filter" };
  return { kind: "ask", rule: "other-command" };
}

/**
 * A command is allowed outright only when it is one step that reads an env file or runs a read-only `ak secrets`. Steps
 * joined by `|`, `;` or a newline go to Jev, and only when every step is one of those, or a pipe filter after a pipe.
 * Anything else in the line (a substitution, a redirect, `&`, a network or script program) is `ask` without Jev, so
 * no answer from a model can let it through.
 */
function classifyCommand(command: string, context: PermissionContext): PermissionDecision {
  const strict = classifyStrictCommand(command, context);
  if (strict.verdict !== "ask") return strict;
  const readOnly = readOnlyCommand(command, {
    otherAllowed: (tokens) => {
      const step = classifyStep(tokens, context);
      return step.kind === "allow" && step.rule !== RUN_RULE;
    },
    approvedExists: (argument) => literalExists(context.cwd, argument),
  });
  return readOnly ? { verdict: "allow", rule: READ_ONLY_RULE } : strict;
}

function classifyStrictCommand(command: string, context: PermissionContext): PermissionDecision {
  if (SHELL_SYNTAX.test(command)) return { verdict: "ask", rule: "shell-syntax" };
  const parts = command.split(SEPARATORS);
  const steps: Array<{ tokens: string[] | null; afterPipe: boolean }> = [];
  for (let i = 0; i < parts.length; i += 2) {
    steps.push({ tokens: words(parts[i]!), afterPipe: i > 0 && parts[i - 1] === "|" });
  }
  if (steps.some((step) => !step.tokens?.length)) return { verdict: "ask", rule: "unparseable-command" };
  if (steps.length === 1) {
    const step = classifyStep(steps[0]!.tokens!, context);
    return step.kind === "allow" ? { verdict: "allow", rule: step.rule } : { verdict: "ask", rule: step.kind === "ask" ? step.rule : "other-command" };
  }
  for (const { tokens, afterPipe } of steps) {
    const step = classifyStep(tokens!, context);
    // A run starts a program with a value in its environment: it is never one step of a longer line.
    if ((step.kind === "allow" && step.rule !== RUN_RULE) || (step.kind === "filter" && afterPipe)) continue;
    return { verdict: "ask", rule: "compound-command" };
  }
  return { verdict: "ambiguous", rule: "compound-secret-command" };
}

/** The ref of a plain `ak secrets request <REF>` command, or null for any other command. */
export function akSecretsRequestRef(command: string): string | null {
  if (SHELL_SYNTAX.test(command)) return null;
  const tokens = words(command);
  if (!tokens || tokens[0] !== "ak" || tokens[1] !== "secrets" || tokens[2] !== "request") return null;
  const spec = AK_SUBCOMMANDS.request!;
  for (let i = 3; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) return token;
    if (spec.valueFlags.includes(token)) i += 1;
  }
  return null;
}

export function classifyPermission(
  request: Pick<PaseoPermissionRequest, "kind" | "detail" | "input" | "name">,
  context: PermissionContext = {},
): PermissionDecision {
  if (request.kind !== "tool") return { verdict: "ask", rule: "not-a-tool-request" };
  const target = permissionTarget(request);
  if (!target) return { verdict: "ask", rule: "unreadable-request" };
  if (target.kind === "file") {
    const envFile = context.envFile ?? isRealEnvFile;
    return isEnvFilePath(target.filePath) && envFile(context.cwd, target.filePath)
      ? { verdict: "allow", rule: "env-file-read" }
      : { verdict: "ask", rule: "other-file" };
  }
  return classifyCommand(target.command, context);
}
