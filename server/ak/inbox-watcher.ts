import { createHash, randomUUID } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { redactSecretsInText } from "../../shared/redact.ts";
import type { ExternalApprovals } from "../external-approvals.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { BotRecord } from "../store.ts";
import { AkError, type AkCli, type AkGrant, type AkPendingRequest, type AkRemoteRequest } from "./cli.ts";
import type { AutoApprovalHistory, PersonAnswer, RequestOrigins } from "../paseo/auto-approval.ts";
import { describeAkError, type AkGuard } from "./guard.ts";
import { isAkRef } from "./vault-sync.ts";

type Told = Awaited<ReturnType<NonNullable<InboxWatcherDeps["notifyAgent"]>>>;

export const AK_CARD_KEY_PREFIX = "ak:";
export const AK_APPROVAL_TTL = "24h";
const PENDING_FILE = "pending.json";
const DEBOUNCE_MS = 200;
const POLL_MS = 2_000;
const POLL_MAX_MS = 60_000;
/** Requests from other devices have no local file to watch, so they are listed on the check cycle, at most this often: each listing opens sealed requests over the network. */
const REMOTE_POLL_MS = 5_000;
const REMOTE_KEY_PREFIX = `${AK_CARD_KEY_PREFIX}remote:`;
const AUTO_APPROVE_ATTEMPTS = 3;
const KNOWN_FIELDS = new Set(["ref", "agent", "fingerprint", "agentLabel", "project", "purpose", "env", "exec", "firstSeen", "lastSeen", "count"]);
const TEXT_CHARS = 160;
const BAD_REF_LOG_LIMIT = 50;

export interface InboxWatcherDeps {
  cli: Pick<AkCli, "pendingRequests" | "approve" | "deny" | "grantExec" | "revokeExec" | "grants"> & Partial<Pick<AkCli, "remoteRequests" | "approveRemote" | "denyRemote">>;
  guard: AkGuard;
  approvals: ExternalApprovals;
  /** True for a ref OpenMausBot wrote to ak from the Vault: the only refs that are approved without a person. */
  owns(ref: string): boolean;
  bot(): Pick<BotRecord, "id" | "name" | "threadId">;
  notify(notification: Notification | null): void;
  screenLocked(): Promise<boolean>;
  log(message: string): void;
  /** The Paseo agent that sent `ak secrets request` for a ref a moment ago. */
  origins?: Pick<RequestOrigins, "find">;
  /** Receives each request allowed without the person, for the Inbox, as an already read line. */
  history?: AutoApprovalHistory;
  /** Tells the Paseo agent that waited for this approval to go on. */
  notifyAgent?(approved: { ref: string; program?: string }): Promise<{ result: "sent" | "queued" | "none"; agent?: { agentId: string; title: string; cwd: string } }>;
  /** The `sha256:<hex>` of a program's file; replaced by tests. */
  hashFile?(path: string): Promise<string>;
  /** The file a path leads to once symbolic links are followed; replaced by tests. */
  realPath?(path: string): Promise<string>;
  /** The folder holding ak's `pending.json`. */
  secretsDir?: string;
  debounceMs?: number;
  pollMs?: number;
  /** The least time between two listings of the requests from other devices; a sync that is off or failing is retried 12 and 6 times slower. */
  remotePollMs?: number;
}

export function agentkitSecretsDir(source: NodeJS.ProcessEnv = process.env): string {
  return join(source.AGENTKIT_HOME || join(homedir(), ".agentkit"), "secrets");
}

interface Scope {
  ref: string;
  agent?: string;
  project?: string;
  purpose?: string;
  /** The environment variable of an exec request. */
  env?: string;
  /** Set for a request from another device: it is answered by this id with `ak secrets approvals`. */
  remoteId?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const oneLine = (value: string, max = TEXT_CHARS): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function scopeOf(request: AkPendingRequest): Scope | null {
  const ref = text(request.ref);
  if (!ref) return null;
  const scope: Scope = { ref };
  // `ak secrets approve --agent` narrows by the agent fingerprint, which the inbox lists as `fingerprint`.
  const agent = text(request.fingerprint) ?? text(request.agent);
  if (agent !== undefined) scope.agent = agent;
  for (const field of ["project", "purpose", "env"] as const) {
    const value = text(request[field]);
    if (value !== undefined) scope[field] = value;
  }
  // `ak secrets approve --json` lists the variable of an exec request inside `exec`, not at the top.
  if (scope.env === undefined && request.exec && typeof request.exec === "object") {
    const env = text((request.exec as Record<string, unknown>).env);
    if (env) scope.env = env;
  }
  return scope;
}

/** A request from another device, read like a local one; null when it has no usable id or ref. */
function remoteScopeOf(item: AkRemoteRequest): Scope | null {
  const id = text(item.id);
  const ref = text(item.ref) ?? text(item.secret) ?? text(item.name);
  if (!id || !ref) return null;
  const scope = scopeOf({ ...item, ref });
  return scope ? { ...scope, remoteId: id } : null;
}

/** The name of the device that asked, when the listing gives one as text or as an object with a name. */
function deviceLabel(request: AkPendingRequest): string | undefined {
  const device = (request as AkRemoteRequest).device;
  if (typeof device === "string") return device;
  if (device && typeof device === "object") return text((device as Record<string, unknown>).name) ?? text((device as Record<string, unknown>).label);
  return undefined;
}

const isExec = (request: AkPendingRequest): boolean =>
  Boolean(text(request.env)) || (request.exec !== undefined && request.exec !== null && request.exec !== "" && request.exec !== false);

/** A key for a remote request is `ak:remote:<id>`; a local key is `ak:[...]`, so the two never meet. */
const keyOf = (request: AkPendingRequest, scope: Scope): string =>
  scope.remoteId ? `${REMOTE_KEY_PREFIX}${scope.remoteId}` : `${AK_CARD_KEY_PREFIX}${JSON.stringify([scope.ref, scope.agent ?? null, scope.project ?? null, scope.purpose ?? null, scope.env ?? null, request.exec ?? null])}`;

function execLabel(request: AkPendingRequest): string {
  const { exec } = request;
  if (typeof exec === "string") return exec;
  if (exec && typeof exec === "object") {
    const fields = exec as Record<string, unknown>;
    // The path is what a grant names, so it is what the person is shown.
    const program = text(fields.path) ?? text(fields.program) ?? text(fields.name);
    if (program) return program;
  }
  return "a program";
}

/** Streams a regular file. `O_NONBLOCK` keeps opening a named pipe from waiting for a writer, and the `fstat` refuses anything but a file. */
async function sha256OfFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error("not a regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await file.close();
  }
}

/** `ak secrets approve` names a request by agent, project, purpose and variable only, so it refuses two exec requests that differ in the program. */
const isAmbiguous = (error: unknown): boolean => error instanceof AkError && error.exitCode === 2 && /waiting requests match/.test(error.message);

/** The absolute program path and pinned hash of an exec request, when the inbox lists them. */
function execProgram(request: AkPendingRequest): { path: string; hash?: string } | null {
  const { exec } = request;
  if (!exec || typeof exec !== "object") return null;
  const fields = exec as Record<string, unknown>;
  const path = text(fields.path);
  const hash = text(fields.hash);
  return path?.startsWith("/") ? { path, ...(hash ? { hash } : {}) } : null;
}

/**
 * Answers the secret requests Paseo agents leave in the `ak` inbox. A request, ordinary or exec, for a secret the person put
 * in the Vault for the Paseo bot is allowed for 24 hours at once. A request for any other ref becomes a card.
 * The list always comes from `ak secrets approve --json`; the file is only watched, never read.
 */
export function startInboxWatcher(deps: InboxWatcherDeps): { checkNow(): Promise<void>; stop(): void } {
  const { cli, guard, approvals, log } = deps;
  const dir = deps.secretsDir ?? agentkitSecretsDir();
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  // A request already dealt with (allowed, or its card answered) stays here until it leaves the inbox.
  const handled = new Set<string>();
  const attempts = new Map<string, number>();
  let watcher: FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;
  let again = false;
  let failures = 0;
  let lastFailure = "";
  let shapeLogged = false;

  const logShapeOnce = (keys: string[]) => {
    if (shapeLogged) return;
    shapeLogged = true;
    log(`ak inbox: unexpected request shape, keys: ${keys.join(", ") || "(none)"}`);
  };

  const badRefs = new Set<string>();
  const warnBadRef = (ref: string) => {
    if (badRefs.has(ref) || badRefs.size >= BAD_REF_LOG_LIMIT) return;
    badRefs.add(ref);
    log(`ak inbox: ignored a request whose ref is not a valid ref: ${JSON.stringify(oneLine(ref, 60))}`);
  };

  async function notifyIfLocked(label: string): Promise<void> {
    if (!(await deps.screenLocked().catch(() => false))) return;
    const bot = deps.bot();
    deps.notify(buildNotification("approval", bot, bot.threadId, oneLine(label, 200)));
  }

  const hashOf = deps.hashFile ?? sha256OfFile;
  const resolve = deps.realPath ?? ((path: string) => realpath(path));

  /** Two paths name one program when they are equal or lead to the same file, such as a Homebrew link into the Cellar. */
  async function sameProgram(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    try {
      return (await resolve(a)) === (await resolve(b));
    } catch {
      return false;
    }
  }

  /** The grant is an allow for this secret, agent, project, purpose and variable, whatever its program. */
  const sameScope = (grant: AkGrant, scope: Scope): boolean =>
    grant.state === "allow" && grant.ref === scope.ref && grant.fingerprint === scope.agent
    && grant.project === scope.project && (grant.purpose ?? "") === (scope.purpose ?? "") && grant.exec?.env === scope.env;

  /** True when `grant` covers exactly this exec request: same scope, program and hash, not expired and, with `since`, recorded at or after it. */
  async function covers(grant: AkGrant, scope: Scope, program: { path: string; hash: string }, since?: number): Promise<boolean> {
    if (!sameScope(grant, scope) || !grant.exec || grant.exec.hash !== program.hash || typeof grant.exec.path !== "string") return false;
    if (grant.expiresAt !== undefined && !(Date.parse(grant.expiresAt) > Date.now())) return false;
    if (since !== undefined && !(Date.parse(grant.createdAt as string) >= since)) return false;
    return sameProgram(grant.exec.path, program.path);
  }

  let grantsFailure = "";
  /** Reads the grants; a failure that lasts is logged once, until a read works again. */
  async function readGrants(): Promise<AkGrant[] | null> {
    try {
      const grants = await cli.grants();
      grantsFailure = "";
      return grants;
    } catch (error) {
      if (guard.report(error)) return null;
      const message = `ak inbox: could not read the grants (${describeAkError(error)})`;
      if (message !== grantsFailure) log(message);
      grantsFailure = message;
      return null;
    }
  }

  /**
   * A request still in the inbox that an earlier answer already granted, so a restart does not ask again or grant again.
   * Only a grant recorded at or after the last time the agent asked counts: an agent that asks again was refused again.
   */
  async function alreadyGranted(request: AkPendingRequest, scope: Scope): Promise<boolean> {
    const program = isExec(request) ? execProgram(request) : null;
    if (scope.remoteId || !program?.hash || scope.agent === undefined || scope.project === undefined || !scope.env) return false;
    const since = Date.parse(text(request.lastSeen) ?? "");
    if (Number.isNaN(since)) return false;
    const found = { path: program.path, hash: program.hash };
    for (const grant of (await readGrants()) ?? []) if (await covers(grant, scope, found, since)) return true;
    return false;
  }

  /**
   * Whether the grant `ak` recorded is for the program and hash the request named; `ak` resolves the program itself.
   * `path` is the program `ak` really wrote, which is what a revoke must name.
   */
  async function grantedAsAsked(result: unknown, scope: Scope, program: { path: string; hash: string }): Promise<{ ok: boolean; path?: string; reason: string }> {
    const recorded = result && typeof result === "object" ? ((result as { grant?: unknown }).grant ?? result) : null;
    const exec = recorded && typeof recorded === "object" ? (recorded as { exec?: AkGrant["exec"] }).exec : null;
    if (exec && typeof exec.hash === "string" && typeof exec.path === "string") {
      const ok = exec.hash === program.hash && (await sameProgram(exec.path, program.path));
      return { ok, path: exec.path, reason: ok ? "" : "the grant ak returned names another program or hash" };
    }
    const grants = await cli.grants().catch((error: unknown) => error);
    if (!Array.isArray(grants)) return { ok: false, reason: `the grants could not be read back (${describeAkError(grants)})` };
    for (const grant of grants as AkGrant[]) if (await covers(grant, scope, program)) return { ok: true, reason: "" };
    const wrong = (grants as AkGrant[]).filter((grant) => sameScope(grant, scope)).sort((a, b) => Date.parse(b.createdAt as string) - Date.parse(a.createdAt as string))[0];
    return { ok: false, ...(typeof wrong?.exec?.path === "string" ? { path: wrong.exec.path } : {}), reason: "no grant read back matches the program and hash of the request" };
  }

  /** Removes the grant `ak` wrote for the wrong program and checks it is gone. Throws the reason it could not be removed. */
  async function removeWrongGrant(exec: Parameters<AkCli["revokeExec"]>[0], scope: Scope, program: { path: string; hash: string }, path: string, reason: string): Promise<never> {
    const stuck = (detail: string) => {
      const message = `A grant for another program than the request named may still be there (${detail}); run ak secrets revoke by hand`;
      log(`ak inbox: ${message} for "${scope.ref}" at ${path}`);
      return new AkError("failed", null, message);
    };
    log(`ak inbox: removing the grant for "${scope.ref}" at ${path}: ${reason}`);
    try {
      await cli.revokeExec({ ...exec, program: path });
    } catch (error) {
      throw stuck(error instanceof AkError && error.exitCode === 2 ? `ak revoke refused the program: ${error.message}` : describeAkError(error));
    }
    const after = await cli.grants().catch((error: unknown) => error);
    if (!Array.isArray(after)) throw stuck(`the grants could not be read to confirm: ${describeAkError(after)}`);
    for (const grant of after as AkGrant[]) {
      if (sameScope(grant, scope) && typeof grant.exec?.path === "string" && (await sameProgram(grant.exec.path, path)) && !(await covers(grant, scope, program))) throw stuck("the wrong grant is still listed");
    }
    throw new AkError("failed", null, "ak recorded a grant for a different program than the request named, so the grant was removed");
  }

  /** Allows the request. When `approve` cannot tell two exec requests apart, the grant names the program of this one. */
  async function allow(request: AkPendingRequest, scope: Scope, answerScope: Scope): Promise<void> {
    // A request from another device is answered by its id for the same time; the program match below is only for local requests.
    if (scope.remoteId) {
      if (!cli.approveRemote) throw new AkError("unavailable", null, "This ak cannot answer requests from other devices");
      return cli.approveRemote({ id: scope.remoteId, ttl: AK_APPROVAL_TTL });
    }
    try {
      await cli.approve({ ...answerScope, ttl: AK_APPROVAL_TTL });
    } catch (error) {
      const program = isExec(request) ? execProgram(request) : null;
      if (!isAmbiguous(error) || !program || scope.agent === undefined || scope.project === undefined || !scope.env) throw error;
      // The grant pins whatever the file is now, so the request must carry the hash it asked with and the file must still have it.
      if (!program.hash) throw new AkError("failed", null, "The request has no program hash, so it was not allowed");
      if ((await hashOf(program.path).catch(() => "")) !== program.hash) {
        throw new AkError("failed", null, "The program changed since it asked, so it was not allowed");
      }
      const found = { path: program.path, hash: program.hash };
      const label = text(request.agentLabel);
      const exec = { ref: scope.ref, agent: scope.agent, env: scope.env, program: program.path, project: scope.project, ...(scope.purpose !== undefined ? { purpose: scope.purpose } : {}) };
      const result = await cli.grantExec({ ...exec, ttl: AK_APPROVAL_TTL, ...(label ? { agentLabel: label } : {}) });
      const verdict = await grantedAsAsked(result, scope, found);
      if (!verdict.ok) return removeWrongGrant(exec, scope, found, verdict.path ?? program.path, verdict.reason);
      log(`ak inbox: several requests for "${scope.ref}" matched, so it was allowed by its program ${program.path}`);
    }
  }

  async function ask(request: AkPendingRequest, scope: Scope, key: string): Promise<void> {
    const exec = isExec(request);
    const label = text(request.agentLabel);
    const agent = label ? `agent ${oneLine(label, 60)}` : scope.agent ? `agent ${scope.agent.replace(/^sha256:/, "").slice(0, 12)}` : "an agent";
    const device = scope.remoteId ? (deviceLabel(request) ?? "another device") : undefined;
    const lines = [oneLine(`${scope.ref} · ${agent}${scope.purpose ? ` · ${scope.purpose}` : ""}`)];
    if (device) lines.push(oneLine(`From ${device}`));
    if (exec) lines.push(oneLine(`Only for ${execLabel(request)}, in the variable ${scope.env ?? "(unnamed)"}`));
    const bot = deps.bot();
    // An ordinary answer names the ordinary request, so an exec request for the same ref is never answered by it.
    const answerScope: Scope = { ...scope, ...(exec ? {} : { env: "" }) };
    const opened = approvals.open({
      key,
      threadId: bot.threadId,
      title: exec ? "A Paseo agent asks to run a program with a secret" : "A Paseo agent asks for a secret",
      subtitle: lines.join("\n"),
      tool: "ak secrets request",
      allowLabel: `Allow ${AK_APPROVAL_TTL}`,
      onAnswer: async (decision) => {
        handled.add(key);
        try {
          if (decision === "allow") {
            await allow(request, scope, answerScope);
            void tellAgent(scope, request).then((told) => record(scope, request, told, { decision: "allow" }));
          } else {
            if (scope.remoteId) {
              if (!cli.denyRemote) throw new AkError("unavailable", null, "This ak cannot answer requests from other devices");
              await cli.denyRemote({ id: scope.remoteId });
            } else {
              await cli.deny(answerScope);
            }
            record(scope, request, undefined, { decision: "deny" });
          }
        } catch (error) {
          // The answer did not reach ak and the request is still in the inbox: the next pass opens a new card for it.
          handled.delete(key);
          guard.report(error);
          throw error;
        }
      },
    });
    if (!opened) return;
    log(`ak inbox: asked the person about a request for "${scope.ref}"`);
    await notifyIfLocked(`${scope.ref} · ${agent}`);
  }

  /** One line for the Inbox: the secret's ref and purpose, the 24 hours, and the Paseo agent that asked when it is known. */
  /** The agent that waited is told; a failure is logged and never undoes the approval. */
  async function tellAgent(scope: Scope, request: AkPendingRequest): Promise<Told> {
    if (!deps.notifyAgent) return { result: "none" };
    try {
      return await deps.notifyAgent({ ref: scope.ref, ...(isExec(request) ? { program: execLabel(request) } : {}) });
    } catch (error) {
      log(`ak inbox: could not tell the agent about "${scope.ref}" (${error instanceof Error ? error.message : String(error)})`);
      return { result: "none" };
    }
  }

  function record(scope: Scope, request: AkPendingRequest, told: Told = { result: "none" }, answer?: PersonAnswer): void {
    if (!deps.history) return;
    // The agent the notice found by its commands counts as much as the one the gatekeeper saw ask.
    const seen = deps.origins?.find(scope.ref) ?? null;
    const origin = told.agent ? { agentId: told.agent.agentId, agent: told.agent.title, cwd: told.agent.cwd || "không rõ project" } : seen;
    const label = text(request.agentLabel);
    const agent = origin?.agent ?? (label ? oneLine(label, 60) : scope.agent ? scope.agent.replace(/^sha256:/, "").slice(0, 12) : "không rõ");
    const exec = isExec(request);
    const purpose = scope.purpose ? `, mục đích: ${redactSecretsInText(oneLine(scope.purpose, 100))}` : "";
    // A refusal grants nothing, so its line names no lifetime and no notice to the agent.
    const denied = answer !== undefined && "decision" in answer && answer.decision === "deny";
    const ttl = denied ? "" : `, ${AK_APPROVAL_TTL}`;
    const what = exec
      ? redactSecretsInText(oneLine(`cấp quyền chạy ${execLabel(request)} với bí mật ${scope.ref} trong biến ${scope.env ?? "(không tên)"}${purpose}${ttl}`, 300))
      : `cấp quyền đọc bí mật ${scope.ref}${purpose}${ttl}`;
    const notice = denied || !deps.notifyAgent ? "" : !told.agent && told.result === "none" ? " · không rõ agent, chưa báo" : " · đã báo agent";
    try {
      const key = `${AK_CARD_KEY_PREFIX}${scope.remoteId ? "remote|" : ""}${scope.ref}|${origin?.agentId ?? scope.agent ?? ""}|${scope.purpose ?? ""}|${exec ? `${execLabel(request)}|${scope.env ?? ""}` : ""}`;
      // Each answer of the person is its own line; only what was allowed without asking merges repeats.
      deps.history({ key: answer ? `${key}|answer|${randomUUID()}` : key, agent, workspace: origin?.cwd ?? "không rõ project", what: `${what}${notice}`,
        rule: answer ? "person" : exec ? "ak-exec-owned-ref" : "ak-vault-secret", ...(answer ? { answer } : {}) });
    } catch (error) {
      log(`ak inbox: could not write the history line (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** True when the request needs no card: it was allowed, or `ak` refuses to be driven from here at all. */
  async function autoApprove(scope: Scope, key: string, request: AkPendingRequest): Promise<boolean> {
    handled.add(key);
    try {
      // An exec request is answered for its own program and variable, exactly as the card's Allow does.
      await allow(request, scope, { ...scope, ...(isExec(request) ? {} : { env: "" }) });
      log(`ak inbox: allowed "${scope.ref}" for ${AK_APPROVAL_TTL}`);
      record(scope, request, await tellAgent(scope, request));
      return true;
    } catch (error) {
      if (guard.report(error)) return true;
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      log(`ak inbox: could not allow "${scope.ref}" (${describeAkError(error)})`);
      if (count < AUTO_APPROVE_ATTEMPTS) {
        handled.delete(key);
        return true;
      }
      return false;
    }
  }

  const remotePollMs = deps.remotePollMs ?? REMOTE_POLL_MS;
  let remoteList: AkRemoteRequest[] = [];
  let remoteNextAt = 0;
  let remoteFailure = "";
  let remoteShapeLogged = false;

  /** Lists the requests from other devices at most every `remotePollMs`. Never throws: a sync that is off or a failure that lasts is logged once. */
  async function refreshRemote(): Promise<void> {
    if (!cli.remoteRequests || Date.now() < remoteNextAt) return;
    try {
      remoteList = await cli.remoteRequests();
      remoteNextAt = Date.now() + remotePollMs;
      remoteFailure = "";
    } catch (error) {
      if (guard.report(error)) return;
      const off = error instanceof AkError && error.kind === "sync-off";
      // Without sync there are no remote requests, so their cards close; after another failure the last list stays.
      if (off) remoteList = [];
      remoteNextAt = Date.now() + remotePollMs * (off ? 12 : 6);
      const message = off ? "ak inbox: requests from other devices are not read because ak sync is off on this device" : `ak inbox: could not read the requests from other devices (${describeAkError(error)})`;
      if (message !== remoteFailure) log(message);
      remoteFailure = message;
    }
  }

  async function pass(): Promise<void> {
    await refreshRemote();
    const pending = await cli.pendingRequests();
    const live = new Set<string>();
    const entries: Array<{ request: AkPendingRequest; scope: Scope | null; remote: boolean }> = [
      ...pending.map((request) => ({ request, remote: false, scope: request !== null && typeof request === "object" ? scopeOf(request) : null })),
      ...remoteList.map((request) => ({ request: request as AkPendingRequest, remote: true, scope: request !== null && typeof request === "object" ? remoteScopeOf(request) : null })),
    ];
    for (const { request, scope, remote } of entries) {
      if (!scope) {
        const keys = request !== null && typeof request === "object" ? Object.keys(request) : [typeof request];
        if (!remote) logShapeOnce(keys);
        else if (!remoteShapeLogged) {
          remoteShapeLogged = true;
          log(`ak inbox: unexpected remote request shape, keys: ${keys.join(", ") || "(none)"}`);
        }
        continue;
      }
      if (!remote && !shapeLogged && Object.keys(request).some((field) => !KNOWN_FIELDS.has(field))) logShapeOnce(Object.keys(request));
      // The ref is text from outside: a name `ak` would not accept as a ref gets no card and reaches no `ak` command.
      if (!isAkRef(scope.ref)) {
        warnBadRef(scope.ref);
        continue;
      }
      const key = keyOf(request, scope);
      live.add(key);
      if (handled.has(key) || approvals.has(key)) continue;
      if (await alreadyGranted(request, scope)) {
        handled.add(key);
        continue;
      }
      if (deps.owns(scope.ref)) {
        if (await autoApprove(scope, key, request)) continue;
        // Allowing it failed three times: a person decides.
        handled.delete(key);
      }
      await ask(request, scope, key);
    }
    for (const key of [...handled, ...attempts.keys()]) {
      if (live.has(key)) continue;
      handled.delete(key);
      attempts.delete(key);
    }
    for (const key of approvals.keys()) if (key.startsWith(AK_CARD_KEY_PREFIX) && !live.has(key)) approvals.close(key);
  }

  async function run(): Promise<void> {
    do {
      again = false;
      if (stopped || guard.blocked) return;
      try {
        await pass();
        failures = 0;
        lastFailure = "";
      } catch (error) {
        if (guard.report(error)) return;
        failures += 1;
        const message = `ak inbox: could not read the inbox (${describeAkError(error)})`;
        if (message !== lastFailure) log(message);
        lastFailure = message;
      }
    } while (again);
  }

  function checkNow(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
    });
    return running;
  }

  // The folder is watched, not the file: ak replaces the file by renaming, which ends a watch on the file itself.
  function ensureWatch(): void {
    if (watcher || stopped || guard.blocked) return;
    try {
      watcher = watch(dir, (_event, name) => {
        if (name === null || String(name) === PENDING_FILE) trigger();
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }

  function trigger(): void {
    if (stopped || guard.blocked) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void checkNow(), debounceMs);
    debounce.unref();
  }

  function schedulePoll(): void {
    if (stopped || guard.blocked) return;
    poll = setTimeout(() => {
      void checkNow().finally(() => {
        ensureWatch();
        schedulePoll();
      });
    }, Math.min(POLL_MAX_MS, pollMs * 2 ** Math.min(failures, 5)));
    poll.unref();
  }

  function stop(): void {
    stopped = true;
    if (debounce) clearTimeout(debounce);
    if (poll) clearTimeout(poll);
    watcher?.close();
    watcher = null;
    for (const key of approvals.keys()) if (key.startsWith(AK_CARD_KEY_PREFIX)) approvals.close(key);
  }

  guard.onBlock(stop);
  ensureWatch();
  void checkNow().finally(schedulePoll);
  return { checkNow, stop };
}
