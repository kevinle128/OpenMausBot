import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExternalApprovals } from "../external-approvals.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { BotRecord } from "../store.ts";
import type { AkCli, AkPendingRequest } from "./cli.ts";
import { describeAkError, type AkGuard } from "./guard.ts";
import { isAkRef } from "./vault-sync.ts";

export const AK_CARD_KEY_PREFIX = "ak:";
export const AK_APPROVAL_TTL = "24h";
const PENDING_FILE = "pending.json";
const DEBOUNCE_MS = 200;
const POLL_MS = 2_000;
const POLL_MAX_MS = 60_000;
const AUTO_APPROVE_ATTEMPTS = 3;
const KNOWN_FIELDS = new Set(["ref", "agent", "fingerprint", "agentLabel", "project", "purpose", "env", "exec", "firstSeen", "lastSeen", "count"]);
const TEXT_CHARS = 160;
const BAD_REF_LOG_LIMIT = 50;

export interface InboxWatcherDeps {
  cli: Pick<AkCli, "pendingRequests" | "approve" | "deny">;
  guard: AkGuard;
  approvals: ExternalApprovals;
  /** True for a ref OpenMausBot wrote to ak from the Vault: the only refs that are approved without a person. */
  owns(ref: string): boolean;
  bot(): Pick<BotRecord, "id" | "name" | "threadId">;
  notify(notification: Notification | null): void;
  screenLocked(): Promise<boolean>;
  log(message: string): void;
  /** The folder holding ak's `pending.json`. */
  secretsDir?: string;
  debounceMs?: number;
  pollMs?: number;
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
  return scope;
}

const isExec = (request: AkPendingRequest): boolean =>
  Boolean(text(request.env)) || (request.exec !== undefined && request.exec !== null && request.exec !== "" && request.exec !== false);

const keyOf = (request: AkPendingRequest, scope: Scope): string =>
  `${AK_CARD_KEY_PREFIX}${JSON.stringify([scope.ref, scope.agent ?? null, scope.project ?? null, scope.purpose ?? null, scope.env ?? null, request.exec ?? null])}`;

function execLabel(request: AkPendingRequest): string {
  const { exec } = request;
  if (typeof exec === "string") return exec;
  if (exec && typeof exec === "object") {
    const fields = exec as Record<string, unknown>;
    const program = text(fields.program) ?? text(fields.path) ?? text(fields.name);
    if (program) return program;
  }
  return "a program";
}

/**
 * Answers the secret requests Paseo agents leave in the `ak` inbox. An ordinary request for a secret the person put in
 * the Vault for the Paseo bot is allowed for 24 hours at once. An exec request, or one for any other ref, becomes a card.
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

  async function ask(request: AkPendingRequest, scope: Scope, key: string): Promise<void> {
    const exec = isExec(request);
    const label = text(request.agentLabel);
    const agent = label ? `agent ${oneLine(label, 60)}` : scope.agent ? `agent ${scope.agent.replace(/^sha256:/, "").slice(0, 12)}` : "an agent";
    const lines = [oneLine(`${scope.ref} · ${agent}${scope.purpose ? ` · ${scope.purpose}` : ""}`)];
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
      onAnswer: async (decision) => {
        handled.add(key);
        try {
          if (decision === "allow") await cli.approve({ ...answerScope, ttl: AK_APPROVAL_TTL });
          else await cli.deny(answerScope);
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

  /** True when the request needs no card: it was allowed, or `ak` refuses to be driven from here at all. */
  async function autoApprove(scope: Scope, key: string): Promise<boolean> {
    handled.add(key);
    try {
      await cli.approve({ ...scope, env: "", ttl: AK_APPROVAL_TTL });
      log(`ak inbox: allowed "${scope.ref}" for ${AK_APPROVAL_TTL}`);
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

  async function pass(): Promise<void> {
    const pending = await cli.pendingRequests();
    const live = new Set<string>();
    for (const request of pending) {
      const isObject = request !== null && typeof request === "object";
      const scope = isObject ? scopeOf(request) : null;
      if (!scope) {
        logShapeOnce(isObject ? Object.keys(request) : [typeof request]);
        continue;
      }
      if (!shapeLogged && Object.keys(request).some((field) => !KNOWN_FIELDS.has(field))) logShapeOnce(Object.keys(request));
      // The ref is text from outside: a name `ak` would not accept as a ref gets no card and reaches no `ak` command.
      if (!isAkRef(scope.ref)) {
        warnBadRef(scope.ref);
        continue;
      }
      const key = keyOf(request, scope);
      live.add(key);
      if (handled.has(key) || approvals.has(key)) continue;
      if (!isExec(request) && deps.owns(scope.ref)) {
        if (await autoApprove(scope, key)) continue;
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
