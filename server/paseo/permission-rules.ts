import type { PaseoPathInspection, PaseoPermissionRequest } from "./connection.ts";
import { gitConfigRunsNoProgram } from "./git-config-check.ts";
import { READ_ONLY_RULE, readOnlyCommand } from "./read-only-commands.ts";
import { words } from "./shell-words.ts";

export type PermissionVerdict = "allow" | "ask" | "ambiguous";

export interface PermissionDecision {
  verdict: PermissionVerdict;
  /** A fixed id, safe to log: it never carries the command or file name. */
  rule: string;
  /** Set on an `ask` that came from a hidden hazard (an unsafe git setting or hook, CDPATH, a real file named `APPROVED:…`): a
   * model must not be asked to overrule it. */
  hazard?: true;
}

/** What a request wants to do, as far as the rules can read it. */
export type PermissionTarget = { kind: "command"; command: string } | { kind: "file"; filePath: string };

/** What the rules ask of the machine the agent works on: what a path is, without following a link. It rejects or answers
 * with an `error` when it cannot tell. */
export type PathInspector = (cwd: string, filePath: string) => Promise<PaseoPathInspection>;

/** What the rules need from the machine. Every file check goes through `inspectPath`; the agent's files are never read from
 * the disk of the machine OpenMausBot runs on. */
export interface PermissionContext {
  /** The agent's working directory, for a path that is not absolute. Without it no file check can be made. */
  cwd?: string;
  /** What is at a path on the agent's machine. Without it, or when it fails, no file is taken for a plain file. */
  inspectPath?: PathInspector;
  /** Replaced by tests. Whether a path is a plain file whose name is an env file name. */
  envFile?: (cwd: string | undefined, filePath: string) => boolean | Promise<boolean>;
  /** Replaced by tests. Whether a path is an existing regular file, whatever its name. */
  regularFile?: (cwd: string | undefined, filePath: string) => boolean | Promise<boolean>;
  /** Set by `classifyPermission` while it works; not for callers. */
  hazard?: { hit: boolean };
  /** Replaced by tests. Whether no git setting in this directory makes a read run another program. */
  gitConfigSafe?: (dir: string | undefined) => boolean;
}

/** The hook of AgentKit puts this before a path it let the person approve once. */
export const APPROVED_PREFIX = "APPROVED:";

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

/** What is at the path, or null when that cannot be told: no inspector, no working directory, a refusal, an error or a timeout. */
async function inspect(context: PermissionContext, filePath: string): Promise<PaseoPathInspection | null> {
  if (!context.inspectPath || !context.cwd) return null;
  try {
    const answer = await context.inspectPath(context.cwd, filePath);
    return answer.error ? null : answer;
  } catch {
    return null;
  }
}

/** True when anything (a file, a link, a pipe) is named exactly like this path, or when that cannot be told. A `..` step cannot
 * be told: the check folds it away by name, while the shell first follows a link named by the step before it. */
async function literalExists(context: PermissionContext, filePath: string): Promise<boolean> {
  if (filePath.split(/[\\/]/).includes("..")) return true;
  const found = await inspect(context, filePath);
  return found === null || found.exists;
}

/** True for an existing regular file, whatever its name. A link is not one: the answer describes the link itself. */
async function isPlainFile(context: PermissionContext, filePath: string): Promise<boolean> {
  const found = await inspect(context, filePath);
  return found !== null && found.exists && found.kind === "file";
}

export const isRegularFile = (context: PermissionContext, filePath: string): boolean | Promise<boolean> =>
  context.regularFile ? context.regularFile(context.cwd, filePath) : isPlainFile(context, filePath);

/** True for a plain file named like an env file. The name is checked by the caller; a link is refused, so the real name is
 * the name given. */
const isEnvFile = (context: PermissionContext, filePath: string): boolean | Promise<boolean> =>
  context.envFile ? context.envFile(context.cwd, filePath) : isPlainFile(context, filePath);

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

async function readsOnlyEnvFiles(tool: string, args: string[], context: PermissionContext): Promise<boolean> {
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
  if (files.length === 0) return false;
  // A path the person approved once with the hook of AgentKit may be any regular file; every other path must be an env file.
  for (const file of files) {
    // The shell opens the literal argument, so a file or link really named like that must not slip through the prefix.
    if (file.startsWith(APPROVED_PREFIX)) {
      if (await literalExists(context, file)) {
        if (context.hazard) context.hazard.hit = true;
        return false;
      }
      if (!(await isRegularFile(context, file.slice(APPROVED_PREFIX.length)))) return false;
    } else if (!isEnvFilePath(file) || !(await isEnvFile(context, file))) {
      return false;
    }
  }
  return true;
}

function isPipeFilter(tool: string, args: string[]): boolean {
  const spec = Object.hasOwn(PIPE_FILTERS, tool) ? PIPE_FILTERS[tool] : undefined;
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

/** One command with no pipe or separator. */
async function classifyStep(tokens: string[], context: PermissionContext): Promise<Step> {
  const [tool, ...args] = tokens as [string, ...string[]];
  if (ENV_FILE_READERS.has(tool) && (await readsOnlyEnvFiles(tool, args, context))) {
    return { kind: "allow", rule: args.some((arg) => arg.startsWith(APPROVED_PREFIX)) ? "approved-file-read-command" : "env-file-read-command" };
  }
  if (isPipeFilter(tool, args)) return { kind: "filter" };
  return { kind: "ask", rule: "other-command" };
}

/**
 * Three outcomes. A command is allowed outright when it is one step that reads an env file, or when the whole line only
 * reads (see read-only-commands.ts). Steps joined by `|`, `;` or a newline go to Jev only when every step is an env-file
 * read or a pipe filter after a pipe. Anything else is `ask`: the gatekeeper then lets Jev Guard judge it, except an
 * `ask` with `hazard` set, which only the person may allow.
 */
async function classifyCommand(command: string, context: PermissionContext): Promise<PermissionDecision> {
  const strict = await classifyStrictCommand(command, context);
  if (strict.verdict !== "ask") return strict;
  const readOnly = await readOnlyCommand(command, {
    cwd: context.cwd,
    gitConfigSafe: context.gitConfigSafe ?? gitConfigRunsNoProgram,
    // The shell opens the name in the directory a leading `cd` moved to; an unknown directory cannot be checked.
    // The name is joined as text, so no `..` in it is folded away before the check.
    approvedExists: (dir, argument) => {
      if (!dir) return true;
      return literalExists(context, dir === context.cwd ? argument : `${dir.replace(/\/+$/, "")}/${argument}`);
    },
    hazard: () => {
      if (context.hazard) context.hazard.hit = true;
    },
  });
  return readOnly ? { verdict: "allow", rule: READ_ONLY_RULE } : strict;
}

async function classifyStrictCommand(command: string, context: PermissionContext): Promise<PermissionDecision> {
  if (SHELL_SYNTAX.test(command)) return { verdict: "ask", rule: "shell-syntax" };
  const parts = command.split(SEPARATORS);
  const steps: Array<{ tokens: string[] | null; afterPipe: boolean }> = [];
  for (let i = 0; i < parts.length; i += 2) {
    steps.push({ tokens: words(parts[i]!), afterPipe: i > 0 && parts[i - 1] === "|" });
  }
  if (steps.some((step) => !step.tokens?.length)) return { verdict: "ask", rule: "unparseable-command" };
  if (steps.length === 1) {
    const step = await classifyStep(steps[0]!.tokens!, context);
    return step.kind === "allow" ? { verdict: "allow", rule: step.rule } : { verdict: "ask", rule: step.kind === "ask" ? step.rule : "other-command" };
  }
  for (const { tokens, afterPipe } of steps) {
    const step = await classifyStep(tokens!, context);
    if (step.kind === "allow" || (step.kind === "filter" && afterPipe)) continue;
    return { verdict: "ask", rule: "compound-command" };
  }
  return { verdict: "ambiguous", rule: "compound-secret-command" };
}

export async function classifyPermission(
  request: Pick<PaseoPermissionRequest, "kind" | "detail" | "input" | "name">,
  context: PermissionContext = {},
): Promise<PermissionDecision> {
  if (request.kind !== "tool") return { verdict: "ask", rule: "not-a-tool-request" };
  const target = permissionTarget(request);
  if (!target) return { verdict: "ask", rule: "unreadable-request" };
  if (target.kind === "file") {
    if (!isEnvFilePath(target.filePath)) return { verdict: "ask", rule: "other-file" };
    // An env file name that is not a plain file there (a link, a pipe, a daemon that cannot tell) is for the person alone.
    return (await isEnvFile(context, target.filePath))
      ? { verdict: "allow", rule: "env-file-read" }
      : { verdict: "ask", rule: "other-file", hazard: true };
  }
  const hazard = { hit: false };
  const decision = await classifyCommand(target.command, { ...context, hazard });
  return decision.verdict === "ask" && hazard.hit ? { ...decision, hazard: true } : decision;
}
