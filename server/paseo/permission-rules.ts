import type { PaseoPermissionRequest } from "./connection.ts";

export type PermissionVerdict = "allow" | "ask" | "ambiguous";

export interface PermissionDecision {
  verdict: PermissionVerdict;
  /** A fixed id, safe to log: it never carries the command or file name. */
  rule: string;
}

/** What a request wants to do, as far as the rules can read it. */
export type PermissionTarget = { kind: "command"; command: string } | { kind: "file"; filePath: string };

const READ_SUBCOMMANDS = new Set(["get", "list", "search", "describe", "request", "resolve", "audit", "grants"]);
const WRITE_SUBCOMMANDS = new Set([
  "set", "delete", "rotate", "grant", "approve", "revoke", "import-env", "export", "sync", "trust", "alias", "annotate", "recovery",
]);

/** Flags that only change how a file is shown. `rg --pre` and `grep -f` run or load other things, so they are not here. */
const SAFE_FLAGS: Record<string, RegExp> = {
  cat: /^-[nAEbsTv]+$/,
  head: /^-[nqvc]+$/,
  tail: /^-[nqvc]+$/,
  less: /^-[nNSRi]+$/,
  grep: /^-[invwFEclHhsq]+$/,
  rg: /^-[invwFclHhsq]+$/,
};
const ENV_FILE_READERS = new Set([...Object.keys(SAFE_FLAGS), "source", "."]);

const COMPOUND = /[|;&`()\n\r]/;
const NOT_PLAIN = /[$<>*?[\]{}~\\]/;
const ENV_MENTION = /(^|[^\w])\.env(\.[\w-]+)*(?![\w])/;
const AK_SECRETS_MENTION = /(^|[^\w])ak\s+secrets(?![\w-])/;

export function isEnvFilePath(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  return base === ".env" || /^\.env\..+/.test(base);
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
  const command = text(input?.command);
  if (command) return { kind: "command", command };
  if (/^read$/i.test(request.name)) {
    const filePath = text(input?.file_path) ?? text(input?.filePath) ?? text(input?.path);
    if (filePath) return { kind: "file", filePath };
  }
  return null;
}

/** Splits a command with no shell syntax into words; quotes group words and are removed. Null when a quote is left open. */
function words(command: string): string[] | null {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(current);
  return out;
}

function readsOnlyEnvFiles(tool: string, args: string[]): boolean {
  if (tool === "source" || tool === ".") return args.length === 1 && isEnvFilePath(args[0]!);
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
  return files.length > 0 && files.every(isEnvFilePath);
}

function classifyCommand(command: string): PermissionDecision {
  const touches = ENV_MENTION.test(command) || AK_SECRETS_MENTION.test(command);
  if (COMPOUND.test(command)) return touches ? { verdict: "ambiguous", rule: "compound-secret-command" } : { verdict: "ask", rule: "compound-command" };
  if (NOT_PLAIN.test(command)) return { verdict: "ask", rule: "shell-syntax" };
  const tokens = words(command);
  if (!tokens?.length) return { verdict: "ask", rule: "unparseable-command" };
  const [tool, ...args] = tokens as [string, ...string[]];
  if (tool === "ak" && args[0] === "secrets") {
    const sub = args[1] ?? "";
    if (READ_SUBCOMMANDS.has(sub)) return { verdict: "allow", rule: "ak-secrets-read" };
    if (sub === "run") return { verdict: "ask", rule: "ak-secrets-run" };
    return { verdict: "ask", rule: WRITE_SUBCOMMANDS.has(sub) ? "ak-secrets-write" : "ak-secrets-unknown" };
  }
  if (ENV_FILE_READERS.has(tool) && readsOnlyEnvFiles(tool, args)) return { verdict: "allow", rule: "env-file-read-command" };
  return { verdict: "ask", rule: "other-command" };
}

export function classifyPermission(request: Pick<PaseoPermissionRequest, "kind" | "detail" | "input" | "name">): PermissionDecision {
  if (request.kind !== "tool") return { verdict: "ask", rule: "not-a-tool-request" };
  const target = permissionTarget(request);
  if (!target) return { verdict: "ask", rule: "unreadable-request" };
  if (target.kind === "file") {
    return isEnvFilePath(target.filePath) ? { verdict: "allow", rule: "env-file-read" } : { verdict: "ask", rule: "other-file" };
  }
  return classifyCommand(target.command);
}
