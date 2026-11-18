import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export type AkErrorKind =
  | "invalid"
  | "no-such-ref"
  | "exists"
  | "backend"
  | "agent-above-process"
  | "cooldown"
  | "sync-off"
  | "unavailable"
  | "failed";

const KIND_BY_EXIT: Record<number, AkErrorKind> = {
  2: "invalid",
  3: "no-such-ref",
  4: "exists",
  5: "backend",
  6: "agent-above-process",
  9: "cooldown",
};

export class AkError extends Error {
  readonly kind: AkErrorKind;
  readonly exitCode: number | null;
  constructor(kind: AkErrorKind, exitCode: number | null, message: string) {
    super(message);
    this.name = "AkError";
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

export interface AkRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `ak` with an argument list and an optional stdin; replaced by tests. */
export type AkRunner = (args: string[], stdin: string | undefined) => Promise<AkRunResult>;

export interface AkSecretSummary {
  ref: string;
  creator?: string;
  createdAt?: string;
  [field: string]: unknown;
}

/** One waiting request in the inbox. `ak secrets approve --json` only lists, so any field beyond `ref` is optional. */
export interface AkPendingRequest {
  ref: string;
  /** The agent fingerprint, `sha256:<64 hex>`: the value `--agent` takes. */
  fingerprint?: string;
  agentLabel?: string;
  agent?: string;
  project?: string;
  purpose?: string;
  env?: string;
  [field: string]: unknown;
}

/**
 * One request from another synced device, from `ak secrets approvals list --json`. The item shape was never seen with a
 * request in it, so every field is optional and read defensively: `id` names the request, the rest mirrors the local inbox.
 */
export interface AkRemoteRequest {
  id?: string;
  ref?: string;
  /** Other names the secret may be listed under. */
  secret?: string;
  name?: string;
  fingerprint?: string;
  agentLabel?: string;
  agent?: string;
  project?: string;
  purpose?: string;
  env?: string;
  device?: unknown;
  [field: string]: unknown;
}

/** One recorded grant from `ak secrets grants --json`. An exec grant names the variable, the program and its hash. */
export interface AkGrant {
  ref: string;
  project?: string;
  fingerprint?: string;
  purpose?: string;
  state?: string;
  expiresAt?: string;
  exec?: { env?: string; path?: string; hash?: string } | null;
  [field: string]: unknown;
}

interface ExecScope {
  ref: string;
  agent: string;
  env: string;
  program: string;
  project: string;
  purpose?: string;
}

interface RequestScope {
  agent?: string;
  project?: string;
  purpose?: string;
  env?: string;
}

const PASS_THROUGH_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|LANG|LC_[A-Z]+|XDG_[A-Z_]+|AGENTKIT_[A-Z_]+|SSH_AUTH_SOCK|DBUS_SESSION_BUS_ADDRESS)$/;
const TIMEOUT_MS = 30_000;
const SEARCH_DIRS = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];

/** The environment `ak` runs with: the user's home and AgentKit settings, never OMB's own keys. */
export function akEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([name]) => PASS_THROUGH_ENV.test(name)));
}

/** A desktop app starts with a short PATH, so look in the usual install folders too. */
export function findAk(source: NodeJS.ProcessEnv = process.env): string {
  if (source.OMB_AK_BIN) return source.OMB_AK_BIN;
  for (const dir of [...(source.PATH ?? "").split(delimiter), ...SEARCH_DIRS]) {
    if (!dir) continue;
    const candidate = join(dir, "ak");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return "ak";
}

export function defaultAkRunner(bin: string = findAk()): AkRunner {
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        { env: akEnvironment(), timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          if (!error) return resolve({ exitCode: 0, stdout, stderr });
          const code = (error as { code?: string | number }).code;
          if (typeof code === "number") return resolve({ exitCode: code, stdout, stderr });
          reject(new AkError("unavailable", null, code === "ENOENT" ? "The ak program was not found" : `ak could not run: ${error.message.split("\n")[0]}`));
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin ?? "");
    });
}

/** The `error` text ak puts in its JSON envelope. A secret value only ever goes in, so it is never in this text. */
function errorDetail(result: AkRunResult): string {
  for (const text of [result.stdout, result.stderr]) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      continue;
    }
  }
  return result.stderr.trim().split("\n")[0] || `ak exited with code ${result.exitCode}`;
}

/** True when ak's JSON error envelope says sync is not set up on this device: `"sync":{"reason":"not_enabled"}`. */
function syncIsOff(result: AkRunResult): boolean {
  for (const text of [result.stdout, result.stderr]) {
    try {
      const reason = (JSON.parse(text) as { sync?: { reason?: unknown } }).sync?.reason;
      if (typeof reason === "string") return reason === "not_enabled";
    } catch {
      continue;
    }
  }
  return false;
}

export function akErrorFor(result: AkRunResult): AkError {
  const kind = syncIsOff(result) ? "sync-off" : (KIND_BY_EXIT[result.exitCode] ?? "failed");
  return new AkError(kind, result.exitCode, errorDetail(result));
}

function parseData<T>(result: AkRunResult): T {
  try {
    return (JSON.parse(result.stdout) as { data: T }).data;
  } catch {
    throw new AkError("failed", result.exitCode, "ak returned output that is not JSON");
  }
}

const REQUEST_LIST_KEYS = ["requests", "pending", "items", "approvals"];

/** The inbox list from `approve --json`, whose exact shape is not fixed: a bare array, or an object holding the array. */
function requestsIn(data: unknown, onUnknownShape?: (keys: string[]) => void): AkPendingRequest[] {
  if (Array.isArray(data)) return data as AkPendingRequest[];
  if (data === null || data === undefined) return [];
  if (typeof data === "object") {
    for (const key of REQUEST_LIST_KEYS) {
      const list = (data as Record<string, unknown>)[key];
      if (Array.isArray(list)) return list as AkPendingRequest[];
      if (list === null) return [];
    }
  }
  onUnknownShape?.(typeof data === "object" ? Object.keys(data) : [typeof data]);
  return [];
}

export interface AkCli {
  list(): Promise<AkSecretSummary[]>;
  pendingRequests(): Promise<AkPendingRequest[]>;
  /** Requests from the account's other synced devices. Fails with kind `sync-off` when sync is not enabled here. */
  remoteRequests(): Promise<AkRemoteRequest[]>;
  /** Answers a request from another device by its id, never with `ak secrets approve`. */
  approveRemote(options: { id: string; ttl: string }): Promise<void>;
  denyRemote(options: { id: string }): Promise<void>;
  approve(options: RequestScope & { ref: string; ttl: string }): Promise<void>;
  deny(options: RequestScope & { ref: string }): Promise<void>;
  /** Allows one exec scope by its program and agent. `approve` cannot name the program, so two requests that differ only in it are ambiguous there. */
  grantExec(options: ExecScope & { ttl: string; agentLabel?: string }): Promise<unknown>;
  /** Removes the grants of one exec scope, whatever hash they hold. */
  revokeExec(options: ExecScope): Promise<void>;
  grants(): Promise<AkGrant[]>;
  set(ref: string, value: string, options?: { force?: boolean }): Promise<void>;
  rotate(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

const COMMON = ["--json", "--no-interactive"];

/** Flag values go as `--flag=value`, so a value that starts with "-" is still read as a value and never as a flag. */
function narrow(scope: RequestScope): string[] {
  const flags: string[] = [];
  if (scope.agent !== undefined) flags.push(`--agent=${scope.agent}`);
  if (scope.project !== undefined) flags.push(`--project=${scope.project}`);
  if (scope.purpose !== undefined) flags.push(`--purpose=${scope.purpose}`);
  if (scope.env !== undefined) flags.push(`--env=${scope.env}`);
  return flags;
}

/** The id goes first, before flags; an id that starts with "-" would be read as a flag, so it never reaches ak. */
function remoteId(id: string): string[] {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(id)) throw new AkError("invalid", null, "The request id is not a valid id");
  return [id];
}

/** Secret values reach `ak` only on stdin (`--value=-`), so they are in no argument list, log or error. */
export function createAkCli(run: AkRunner = defaultAkRunner(), options: { onUnknownShape?: (keys: string[]) => void } = {}): AkCli {
  const call = async (args: string[], stdin?: string): Promise<AkRunResult> => {
    const result = await run([...args, ...COMMON], stdin);
    if (result.exitCode !== 0) throw akErrorFor(result);
    return result;
  };
  return {
    async list() {
      return parseData<AkSecretSummary[]>(await call(["secrets", "list"]));
    },
    async pendingRequests() {
      return requestsIn(parseData<unknown>(await call(["secrets", "approve"])), options.onUnknownShape);
    },
    async remoteRequests() {
      return requestsIn(parseData<unknown>(await call(["secrets", "approvals", "list"])), options.onUnknownShape) as AkRemoteRequest[];
    },
    async approveRemote({ id, ttl }) {
      await call(["secrets", "approvals", "approve", ...remoteId(id), `--ttl=${ttl}`]);
    },
    async denyRemote({ id }) {
      await call(["secrets", "approvals", "deny", ...remoteId(id)]);
    },
    async approve({ ref, ttl, ...scope }) {
      await call(["secrets", "approve", ref, "--state=ttl", `--ttl=${ttl}`, ...narrow(scope)]);
    },
    async deny({ ref, ...scope }) {
      await call(["secrets", "approve", ref, "--state=deny", ...narrow(scope)]);
    },
    async grantExec({ ref, ttl, agent, env, program, project, purpose, agentLabel }) {
      const result = await call([
        "secrets", "grant", ref, `--agent=${agent}`, `--exec=${program}`, `--env=${env}`, `--ttl=${ttl}`, `--purpose=${purpose ?? ""}`, `--project=${project}`,
        ...(agentLabel ? [`--agent-label=${agentLabel}`] : []),
      ]);
      // The grant is already written, so output that is not JSON must not throw: the caller reads the grants back instead.
      try {
        return parseData<unknown>(result);
      } catch {
        return null;
      }
    },
    async revokeExec({ ref, agent, env, program, project, purpose }) {
      await call(["secrets", "revoke", ref, `--agent=${agent}`, `--exec=${program}`, `--env=${env}`, `--purpose=${purpose ?? ""}`, `--project=${project}`]);
    },
    async grants() {
      const data = parseData<unknown>(await call(["secrets", "grants"]));
      return Array.isArray(data) ? (data as AkGrant[]) : [];
    },
    async set(ref, value, options) {
      await call(["secrets", "set", ref, "--value=-", "--no-push", ...(options?.force ? ["--force"] : [])], value);
    },
    async rotate(ref, value) {
      await call(["secrets", "rotate", ref, "--value=-", "--no-push"], value);
    },
    async delete(ref) {
      await call(["secrets", "delete", ref, "--no-push"]);
    },
  };
}
