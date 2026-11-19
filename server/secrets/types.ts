/** The ref an agent writes in a secret reference: a leading dash would read as a flag, so it is refused. */
export const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const PROGRAM_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Exit codes shared with `ak secrets`: a caller maps the envelope's `exit_code` straight onto its own exit status. */
export const EXIT = { ok: 0, invalid: 2, missing: 3, exists: 4, unavailable: 5, refused: 6, pending: 8, limited: 9 } as const;
export type ExitCode = typeof EXIT[keyof typeof EXIT];

export type ErrorCode =
  | "invalid_request" | "no_such_secret" | "exists" | "store_unavailable" | "refused" | "blocked" | "host_not_allowed"
  | "approval_pending" | "rate_limited" | "no_such_request" | "not_available";

export interface ExecScope {
  /** Absolute path of the program, symbolic links followed by the caller. */
  path: string;
  /** The environment variable the value reaches. */
  env: string;
  /** `sha256:<hex>` of the program file. */
  hash: string;
}

/** What one grant or request is about: all four fields, and the program for an exec scope, must match. */
export interface SecretScope {
  ref: string;
  project: string;
  fingerprint: string;
  /** An empty purpose is a literal value, never a wildcard. */
  purpose: string;
  exec?: ExecScope;
}

export const DAY_MS = 24 * 3_600_000;
export const DEFAULT_ALLOW_MS = DAY_MS;

const TTL = /^(\d+(?:\.\d+)?)(m|h|d|w)$/;
const TTL_UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };
export const TTL_MAX_MS = 3_650 * DAY_MS;

/** `12h`, `30d`, `2w`, `90m` to milliseconds; null when it is not one of those or is out of range. */
export function parseTtl(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const match = TTL.exec(raw.trim());
  if (!match) return null;
  const ms = Math.round(Number(match[1]) * TTL_UNIT[match[2]!]!);
  return ms >= 60_000 && ms <= TTL_MAX_MS ? ms : null;
}

const CONTROL = /[\p{Cc}\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;

/** True when the text holds a control, zero-width or direction character, which could disguise what a card shows. */
export const hasControl = (value: string): boolean => CONTROL.test(value);

/** Free text from a caller, kept to one short line of printable characters. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length <= max && !CONTROL.test(text) ? text : null;
}

/** Attribution text from a caller: control and direction characters dropped and the length cut, never refused. */
export function softText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(new RegExp(CONTROL.source, "gu"), " ").trim().slice(0, max);
  return text || undefined;
}

/** The host a grant names: lowercase, a default port and one trailing dot dropped, an internationalized name in ASCII. */
export function normalizeHost(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text || text.includes("/") || text.includes("@") || /\s/.test(text)) return null;
  try {
    const url = new URL(`https://${text}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    const host = url.hostname.replace(/\.$/, "");
    const port = url.port && url.port !== "443" && url.port !== "80" ? `:${url.port}` : "";
    return host ? `${host}${port}` : null;
  } catch {
    return null;
  }
}

/** The variables that steer a loader, a runtime or the program lookup: a secret is never delivered into them. */
const STEERING = new Set(["PATH", "HOME", "IFS", "SHELL", "ENV", "BASH_ENV", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "CLASSPATH", "GOFLAGS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
export const steersLoader = (name: string): boolean => /^(?:LD_|DYLD_)/.test(name) || STEERING.has(name.toUpperCase());

export class SecretsError extends Error {
  readonly exit: ExitCode;
  readonly code: ErrorCode;
  constructor(exit: ExitCode, code: ErrorCode, message: string) {
    super(message);
    this.exit = exit;
    this.code = code;
  }
}

export const scopeKey = (scope: SecretScope): string =>
  JSON.stringify([scope.ref, scope.project, scope.fingerprint, scope.purpose, scope.exec ? [scope.exec.path, scope.exec.env, scope.exec.hash] : null]);
