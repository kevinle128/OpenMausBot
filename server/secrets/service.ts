import { randomUUID } from "node:crypto";

import { redactSecretsInText } from "../../shared/redact.ts";
import { SECRET_VALUE_MAX_BYTES, vaultNameKey, type SecretProfile } from "../../shared/vault.ts";
import { paseoScopedSecrets } from "./scope.ts";
import type { ExternalApprovals } from "../external-approvals.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { AutoApprovalHistory, PersonAnswer } from "../paseo/auto-approval.ts";
import type { ApprovedSecret, NoticeOutcome } from "../paseo/approval-notice.ts";
import { PASEO_BOT_ID } from "../paseo/gatekeeper.ts";
import { agentTitle, type LiveAgents } from "../paseo/live-agents.ts";
import type { BotRecord } from "../store.ts";
import { TEAM_READER, type VaultStore } from "../vault-store.ts";
import { AuditLedger, type AuditErrorCode, type AuditPage, type AuditQuery, type AuditRow, type AuditSource } from "./audit.ts";
import { FETCH_TIMEOUT_MS, UpstreamError, hostKey, injectSecret, isLoopback, needlesFor, scrubBody, scrubText, sendUpstream, type FetchRequest } from "./fetch.ts";
import { GrantStore, type Grant } from "./grants.ts";
import { PendingStore, RateLimiter, type PendingRequest, type RequestDetails } from "./pending.ts";
import { parseProfile, valueHint } from "./profile.ts";
import {
  DAY_MS, DEFAULT_ALLOW_MS, ENV_VAR_PATTERN, EXIT, FINGERPRINT_PATTERN, PROGRAM_HASH_PATTERN, REF_PATTERN, SecretsError, cleanText, hasControl, normalizeHost, parseTtl, steersLoader,
  type ErrorCode, type ExecScope, type ExitCode, type SecretScope,
} from "./types.ts";

type VaultPort = Pick<VaultStore, "listSecrets" | "secret" | "saveSecret" | "updateSecret" | "removeSecret" | "markUsed">;

export interface SecretsDeps {
  vault: VaultPort;
  dataDir: string;
  approvals: Pick<ExternalApprovals, "open" | "close">;
  paseoBot(): Pick<BotRecord, "id" | "name" | "threadId">;
  history?: AutoApprovalHistory;
  notify?(notification: Notification | null): void;
  screenLocked?(): Promise<boolean>;
  botExists(id: string): boolean;
  log(message: string): void;
  now?: () => number;
  /** The HTTP client `fetch` sends through, and its time limit: replaceable so a test needs no network. */
  httpFetch?: typeof fetch;
  fetchTimeoutMs?: number;
}

/** What the Paseo bridge lends once it runs: the agents the daemon lists, and the way to tell one that its request was approved. */
export interface PaseoPort {
  agents: Pick<LiveAgents, "get">;
  notifier: { approved(approved: ApprovedSecret): Promise<NoticeOutcome> };
}

/** Who is calling: the token session (or `loopback`), and which door the call came through, for the ledger. */
export interface Caller {
  id: string;
  source: AuditSource;
}

/** What the caller says about itself. Only `fingerprint`, `project` and `purpose` take part in a decision. */
export interface Asker {
  fingerprint: string;
  project: string;
  purpose: string;
  agentLabel?: string;
  /** Attribution only: it names the agent on a card and decides who is told, and never authorizes anything. */
  agentId?: string;
  cwd?: string;
  session?: string;
  context?: string;
  destHost?: string;
}

export interface ExecRequest {
  var: string;
  ref: string;
  program: { path: string; hash: string };
}

type Eval =
  | { kind: "covered"; grant: Grant }
  | { kind: "refused"; code: "blocked" | "host_not_allowed"; message: string }
  | { kind: "limited"; message: string }
  | { kind: "pending"; request: PendingRequest; autoGranted: boolean };

export type ApproveState = "deny" | "once" | "ttl" | "persist";

const TEXT_CHARS = 160;
const REVIEW_MESSAGE = "The person was asked on the OpenMausBot card. Run the same call again once it is answered.";
const NO_SECRET_YET = "The secret is not in the Vault yet, so the person was asked; it has to be added in OpenMausBot first.";
const ROTATE_AFTER_MS = 90 * DAY_MS;

const oneLine = (value: string, max = TEXT_CHARS): string => {
  const flat = redactSecretsInText(value).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const CARD: Caller = { id: "card", source: "desktop" };
const adminCaller: Caller = { id: "admin", source: "cli" };
const iso = (ms: number): string => new Date(ms).toISOString();
const cardKey = (requestId: string): string => `omb-secret:${requestId}`;
const ttlLabel = (ms: number): string => (ms % 3_600_000 === 0 && ms <= 2 * DAY_MS ? `${ms / 3_600_000}h` : ms % DAY_MS === 0 ? `${ms / DAY_MS}d` : `${Math.round(ms / 60_000)}m`);
const execLabel = (exec: ExecScope | undefined): string => exec?.path ?? "a program";

export function createSecretsService(deps: SecretsDeps) {
  const now = deps.now ?? Date.now;
  const grants = new GrantStore({ dataDir: deps.dataDir, now });
  const pending = new PendingStore({ dataDir: deps.dataDir, now });
  const ledger = new AuditLedger({ dataDir: deps.dataDir, now });
  const limiter = new RateLimiter(now);
  const background = new Set<Promise<void>>();
  let paseo: PaseoPort | null = null;

  const later = (task: () => Promise<void>): void => {
    const running = task().catch((error: unknown) => deps.log(`omb secrets: ${error instanceof Error ? error.message : String(error)}`)).finally(() => background.delete(running));
    background.add(running);
  };

  /** The newest secret with this exact name. A valid ref is scoped, so the read and the auto-approval agree. */
  function lookup(ref: string): { id: string; scoped: boolean; updatedAt: number } | null {
    const scoped = paseoScopedSecrets(deps.vault).get(ref);
    if (scoped) return { id: scoped.id, scoped: true, updatedAt: scoped.updatedAt };
    const found = deps.vault.listSecrets(TEAM_READER).filter((secret) => secret.name === ref).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return found ? { id: found.id, scoped: false, updatedAt: found.updatedAt } : null;
  }

  const valueOf = (id: string): string | null => deps.vault.secret(id)?.value ?? null;

  function audit(caller: Caller, scope: Pick<SecretScope, "ref" | "project" | "fingerprint" | "purpose">, asker: Partial<Asker>, decision: AuditRow["decision"], errorCode: AuditErrorCode, context: string, source: AuditSource = caller.source, extra: Pick<AuditRow, "method" | "status"> = {}): void {
    ledger.append({
      decision, source, ref: scope.ref, project: redactSecretsInText(scope.project), purpose: redactSecretsInText(scope.purpose), fingerprint: scope.fingerprint,
      agentLabel: oneLine(asker.agentLabel ?? "", 80), sessionId: oneLine(asker.session ?? "", 80), context: oneLine(context, 200), errorCode, caller: caller.id,
      ...(asker.destHost ? { destHost: normalizeHost(asker.destHost) ?? oneLine(asker.destHost, 255) } : {}), ...(asker.agentId ? { agentId: oneLine(asker.agentId, 80) } : {}), ...extra,
    });
  }

  function attribution(asker: Asker): RequestDetails {
    const live = asker.agentId ? paseo?.agents.get(asker.agentId) : undefined;
    const cwd = live?.cwd ?? asker.cwd;
    return {
      ...(asker.agentLabel ? { agentLabel: oneLine(asker.agentLabel, 80) } : {}),
      ...(asker.session ? { sessionId: oneLine(asker.session, 80) } : {}),
      ...(live ? { agentId: live.id, agentTitle: oneLine(agentTitle(live), 80) } : {}),
      ...(cwd ? { cwd: oneLine(cwd, 200) } : {}),
    };
  }

  const agentName = (request: PendingRequest): string =>
    request.agentTitle ?? request.agentLabel ?? (request.fingerprint ? request.fingerprint.replace(/^sha256:/, "").slice(0, 12) : "không rõ");

  function history(request: PendingRequest, extras: { told: NoticeOutcome | null; lifetime?: string; answer?: PersonAnswer }): void {
    if (!deps.history) return;
    const { answer } = extras;
    const purpose = request.purpose ? `, mục đích: ${oneLine(request.purpose, 100)}` : "";
    const denied = answer !== undefined && "decision" in answer && answer.decision === "deny";
    const lifetime = denied ? "" : `, ${extras.lifetime ?? "24h"}`;
    const what = request.exec
      ? oneLine(`cấp quyền chạy ${execLabel(request.exec)} với bí mật ${request.ref} trong biến ${request.exec.env}${purpose}${lifetime}`, 300)
      : `cấp quyền đọc bí mật ${request.ref}${purpose}${lifetime}`;
    const noticed = denied || !extras.told ? "" : extras.told.result === "none" && !extras.told.agent ? " · không rõ agent, chưa báo" : " · đã báo agent";
    const base = `omb|${request.ref}|${request.agentId ?? request.fingerprint}|${request.purpose}|${request.exec ? `${request.exec.path}|${request.exec.env}` : ""}`;
    deps.history({
      key: answer ? `${base}|answer|${randomUUID()}` : base, agent: agentName(request), workspace: request.cwd ?? "không rõ project", what: `${what}${noticed}`,
      rule: answer ? "person" : request.exec ? "omb-exec-owned-ref" : "omb-vault-secret", ...(answer ? { answer } : {}),
    });
  }

  /** Only the live agent the request named is told: without one, nobody is guessed from recent shell commands. */
  async function tell(request: PendingRequest, by?: "omb"): Promise<NoticeOutcome | null> {
    if (!paseo) return null;
    if (!request.agentId) return { result: "none" };
    return paseo.notifier.approved({
      ref: request.ref, vault: "omb", agentId: request.agentId, ...(request.exec ? { program: request.exec.path } : {}), ...(by ? { by } : {}),
    });
  }

  function grantFor(request: SecretScope & { agentLabel?: string }, options: { createdBy: Grant["createdBy"]; expiresAt?: number; once?: boolean }): Grant {
    return grants.add({
      ref: request.ref, project: request.project, fingerprint: request.fingerprint, purpose: request.purpose, ...(request.exec ? { exec: request.exec } : {}),
      state: "allow", createdBy: options.createdBy, ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }), ...(options.once ? { once: true } : {}),
      ...(request.agentLabel ? { agentLabel: request.agentLabel } : {}),
    });
  }

  function openCard(request: PendingRequest, known: boolean): void {
    const bot = deps.paseoBot();
    const agent = request.agentTitle ?? request.agentLabel ?? "an agent";
    const lines = [oneLine(`${request.ref} · agent ${agent}${request.purpose ? ` · ${request.purpose}` : ""}`)];
    if (request.cwd) lines.push(oneLine(`Workspace: ${request.cwd}`));
    if (request.exec) lines.push(oneLine(`Only for ${request.exec.path}, in the variable ${request.exec.env}`));
    if (!known) lines.push(NO_SECRET_YET);
    const opened = deps.approvals.open({
      key: cardKey(request.id),
      threadId: bot.threadId,
      title: request.exec ? "A Paseo agent asks to run a program with a secret" : "A Paseo agent asks for a secret",
      subtitle: lines.join("\n"),
      tool: "omb secrets request",
      allowLabel: "Allow 24h",
      onAnswer: (decision) => {
        settle(request.id, decision === "allow" ? { state: "ttl", ttlMs: DEFAULT_ALLOW_MS } : { state: "deny" }, CARD);
      },
    });
    if (!opened || !deps.notify || !deps.screenLocked) return;
    const notify = deps.notify;
    later(async () => {
      if (await deps.screenLocked!().catch(() => false)) notify(buildNotification("approval", bot, bot.threadId, oneLine(`${request.ref} · ${agent}`, 200)));
    });
  }

  /** Answers one request: a deny stores nothing, so the next ask opens a new card; an allow writes a grant and tells the agent. */
  function settle(requestId: string, answer: { state: "deny" } | { state: "once" | "ttl" | "persist"; ttlMs?: number }, caller: Caller): { granted: Grant | null; request: PendingRequest } {
    const request = pending.get(requestId);
    if (!request) throw new SecretsError(EXIT.invalid, "no_such_request", "no such request waiting: it may have been answered already");
    const asker = { agentLabel: request.agentLabel, session: request.sessionId, agentId: request.agentId };
    if (answer.state === "deny") {
      audit(caller, request, asker, "deny", "denied", "approve:deny");
      pending.remove(request.id);
      deps.approvals.close(cardKey(request.id));
      history(request, { told: null, answer: { decision: "deny" } });
      return { granted: null, request };
    }
    const expiresAt = answer.state === "persist" ? undefined : answer.state === "once" ? undefined : now() + (answer.ttlMs ?? DEFAULT_ALLOW_MS);
    audit(caller, request, asker, "allow", "", `approve:${answer.state}`);
    const granted = grantFor(request, { createdBy: caller === CARD ? "card" : "admin", ...(expiresAt === undefined ? {} : { expiresAt }), once: answer.state === "once" });
    pending.settle(request);
    deps.approvals.close(cardKey(request.id));
    const lifetime = answer.state === "once" ? "một lần" : answer.state === "persist" ? "không hết hạn" : ttlLabel(answer.ttlMs ?? DEFAULT_ALLOW_MS);
    later(async () => history(request, { told: await tell(request).catch(() => null), lifetime, answer: { decision: "allow" } }));
    return { granted, request };
  }

  /** Decides one scope. A scope no grant covers files a request, and either grants it at once (a valid secret in the Vault) or opens a card. A release call that was granted at once goes on with the new grant; a plain request only reports it. */
  function evaluate(scope: SecretScope, asker: Asker, caller: Caller, mode: "release" | "request", admit: () => ReturnType<RateLimiter["admit"]> = () => limiter.admit(scope.fingerprint)): Eval {
    const found = grants.match(scope);
    if (found.kind === "block") {
      audit(caller, scope, asker, "deny", "blocked", asker.context ?? "blocked");
      return { kind: "refused", code: "blocked", message: `${scope.ref}: refused. A person blocked this agent from the secret. Do not try again.` };
    }
    if (found.kind === "allow") {
      const hosts = found.grant.allowHosts;
      if (mode === "release" && hosts?.length && !scope.exec) {
        const host = asker.destHost ? normalizeHost(asker.destHost) : null;
        if (!host || !hosts.includes(host)) {
          audit(caller, scope, asker, "deny", "host_not_allowed", asker.context ?? "host");
          return { kind: "refused", code: "host_not_allowed", message: `${scope.ref}: refused. The grant names the hosts the secret may be sent to, and this call does not go to one of them.` };
        }
      }
      return { kind: "covered", grant: found.grant };
    }
    const admitted = admit();
    if (!admitted.ok) {
      audit(caller, scope, asker, "deny", "rate_limited", asker.context ?? "rate limited");
      return { kind: "limited", message: `${scope.ref}: too many requests from this agent. Do not ask again for about ${Math.ceil(admitted.retryAfterMs / 60_000)} minutes.` };
    }
    const known = lookup(scope.ref);
    const { request } = pending.record(scope, attribution(asker));
    if (known?.scoped) {
      audit(caller, scope, asker, "allow", "", `auto:paseo-scoped ${asker.context ?? ""}`.trim(), "adapter");
      const grant = grantFor(request, { createdBy: "omb", expiresAt: now() + DEFAULT_ALLOW_MS });
      pending.settle(request);
      deps.approvals.close(cardKey(request.id));
      // A release call gets the value now, so only a plain request tells the agent: a notice after a call that went through would wake it to run that call again.
      later(async () => history(request, { told: mode === "request" ? await tell(request, "omb").catch(() => null) : null }));
      return mode === "release" ? { kind: "covered", grant } : { kind: "pending", request, autoGranted: true };
    }
    audit(caller, scope, asker, "deny", "approval_pending", asker.context ?? "approval pending");
    openCard(request, known !== null);
    return { kind: "pending", request, autoGranted: false };
  }

  const pendingError = (ev: Extract<Eval, { kind: "pending" }>): SecretsError =>
    new SecretsError(EXIT.pending, "approval_pending", `${ev.request.ref}: approval is pending. ${REVIEW_MESSAGE}`);

  function refusal(ev: Exclude<Eval, { kind: "covered" }>): SecretsError {
    if (ev.kind === "pending") return pendingError(ev);
    if (ev.kind === "limited") return new SecretsError(EXIT.limited, "rate_limited", ev.message);
    return new SecretsError(EXIT.refused, ev.code, ev.message);
  }

  function checkAsker(asker: Asker): void {
    if (!FINGERPRINT_PATTERN.test(asker.fingerprint)) throw new SecretsError(EXIT.invalid, "invalid_request", "fingerprint must be sha256: and 64 hex digits");
    if (!asker.project || asker.project.length > 512) throw new SecretsError(EXIT.invalid, "invalid_request", "project is required and at most 512 characters");
    if (asker.purpose.length > 200) throw new SecretsError(EXIT.invalid, "invalid_request", "purpose is at most 200 characters");
    if (hasControl(asker.project) || hasControl(asker.purpose)) throw new SecretsError(EXIT.invalid, "invalid_request", "project and purpose cannot hold control or direction characters");
  }

  function checkRef(ref: string): void {
    if (!REF_PATTERN.test(ref)) throw new SecretsError(EXIT.invalid, "invalid_request", "ref must start with a letter or digit and use only letters, digits, _ . -, at most 128 characters");
  }

  function checkExec(program: { path: string; hash: string }, env: string): ExecScope {
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(program.path) || program.path.length > 1_024 || hasControl(program.path)) throw new SecretsError(EXIT.invalid, "invalid_request", "the program must be an absolute path");
    if (!PROGRAM_HASH_PATTERN.test(program.hash)) throw new SecretsError(EXIT.invalid, "invalid_request", "the program hash must be sha256: and 64 hex digits");
    if (!ENV_VAR_PATTERN.test(env) || steersLoader(env)) throw new SecretsError(EXIT.invalid, "invalid_request", "that variable cannot receive a secret");
    return { path: program.path, env, hash: program.hash };
  }

  const scopeOf = (ref: string, asker: Asker, exec?: ExecScope): SecretScope => ({ ref, project: asker.project, fingerprint: asker.fingerprint, purpose: asker.purpose, ...(exec ? { exec } : {}) });

  function release(scope: SecretScope, asker: Asker, caller: Caller, grant: Grant): string {
    const known = lookup(scope.ref);
    const value = known ? valueOf(known.id) : null;
    if (!known || value === null) {
      audit(caller, scope, asker, "deny", "no_such_secret", asker.context ?? "missing");
      throw new SecretsError(EXIT.missing, "no_such_secret", `${scope.ref}: no such secret in the Vault. Ask the person to add it in OpenMausBot.`);
    }
    audit(caller, scope, asker, "allow", "", asker.context ?? "release");
    if (grant.once) grants.spend(grant.id);
    try {
      deps.vault.markUsed(known.id);
    } catch (error) {
      deps.log(`omb secrets: could not record the use of a secret (${error instanceof Error ? error.message : String(error)})`);
    }
    return value;
  }

  function releaseAll(items: Array<{ scope: SecretScope; grant: Grant }>, asker: Asker, caller: Caller): string[] {
    const known = items.map(({ scope }) => ({ scope, record: lookup(scope.ref) }));
    for (const { scope, record } of known) {
      if (!record || valueOf(record.id) === null) {
        audit(caller, scope, asker, "deny", "no_such_secret", asker.context ?? "missing");
        throw new SecretsError(EXIT.missing, "no_such_secret", `${scope.ref}: no such secret in the Vault. Ask the person to add it in OpenMausBot.`);
      }
    }
    for (const { scope } of known) audit(caller, scope, asker, "allow", "", `${asker.context ?? "run"} exec:${scope.exec!.env}=${scope.exec!.path}`);
    const values = known.map(({ record }) => valueOf(record!.id)!);
    for (const { grant } of items) if (grant.once) grants.spend(grant.id);
    for (const { record } of known) {
      try {
        deps.vault.markUsed(record!.id);
      } catch (error) {
        deps.log(`omb secrets: could not record the use of a secret (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return values;
  }

  function describeRow(ref: string, id: string, updatedAt: number) {
    const secret = deps.vault.listSecrets(TEAM_READER).find((one) => one.id === id)!;
    const value = valueOf(id);
    const hint = value === null ? null : valueHint(value);
    return {
      ref, creator: "omb", createdAt: iso(secret.createdAt), rotatedAt: iso(updatedAt), hint, ...(hint === null ? { hintReason: "short value" } : {}),
      needsRotation: now() - updatedAt > ROTATE_AFTER_MS, profile: secret.profile ?? {},
    };
  }

  function checkValue(raw: unknown): string {
    const value = typeof raw === "string" ? raw.replace(/\r?\n$/, "") : "";
    if (!value || Buffer.byteLength(value) > SECRET_VALUE_MAX_BYTES) throw new SecretsError(EXIT.invalid, "invalid_request", `the value is required and at most ${SECRET_VALUE_MAX_BYTES} bytes`);
    return value;
  }

  function checkProfile(raw: unknown, value: string | undefined): SecretProfile | undefined {
    const parsed = parseProfile(raw, value);
    if (!parsed.ok) throw new SecretsError(EXIT.invalid, "invalid_request", parsed.error);
    return parsed.profile;
  }

  function checkBots(raw: unknown): "all" | string[] {
    if (raw === undefined) return [];
    if (raw === "all") return "all";
    if (raw === "paseo") return [PASEO_BOT_ID];
    if (!Array.isArray(raw) || raw.length > 50 || !raw.every((id) => typeof id === "string" && (id === PASEO_BOT_ID || deps.botExists(id)))) {
      throw new SecretsError(EXIT.invalid, "invalid_request", "bots must be all, paseo, or a list of bot ids");
    }
    return [...new Set(raw as string[])];
  }

    return {
    attach(port: PaseoPort): () => void {
      paseo = port;
      return () => {
        if (paseo === port) paseo = null;
      };
    },
    /** Resolves when every notice and history line started so far has been handled. */
    async idle(): Promise<void> {
      while (background.size) await Promise.all(background);
    },

    /** Sends one request for an agent with the value written into it. The value never leaves this process: the answer is the destination's, with every form of the value replaced. */
    async fetch(input: { ref: string; request: FetchRequest; asker: Asker }, caller: Caller): Promise<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }> {
      const { ref, request } = input;
      checkRef(ref);
      checkAsker(input.asker);
      const host = hostKey(request.url);
      if (request.url.protocol === "http:" && !isLoopback(request.url)) throw new SecretsError(EXIT.invalid, "invalid_request", "url must start with https://");
      const context = `fetch ${request.method} ${host}`;
      // The destination is what the request says, never what the caller claims: a host-restricted grant is judged on it.
      const asker: Asker = { ...input.asker, destHost: host, context };
      const scope = scopeOf(ref, asker);
      const known = lookup(ref);
      if (known) {
        const allowed = deps.vault.listSecrets(TEAM_READER).find((secret) => secret.id === known.id)?.profile?.allowedHosts ?? [];
        if (!allowed.includes(host)) {
          audit(caller, scope, asker, "deny", "host_not_allowed", context);
          throw new SecretsError(EXIT.refused, "host_not_allowed", allowed.length
            ? `${ref}: refused. ${host} is not one of the hosts the person allowed for this secret.`
            : `${ref}: refused. The person has not allowed any host for this secret. Ask the person to add the host in OpenMausBot, in the Vault settings of the secret.`);
        }
      }
      const ev = evaluate(scope, asker, caller, "release");
      if (ev.kind !== "covered") throw refusal(ev);
      // A value that cannot go into the request is refused before the release, so it spends no single-release grant and logs no allow.
      const stored = known ? valueOf(known.id) : null;
      if (stored !== null) injectSecret(request, stored);
      const value = release(scope, asker, caller, ev.grant);
      const needles = needlesFor(request, value);
      const mark = `[omb:${ref}]`;
      /** The result row, written after the call: the row before it already let the call go, so a failure here is logged and nothing more. */
      const outcome = (text: string, result: { status?: number; failed?: boolean }) => {
        try {
          audit(caller, scope, asker, "check", result.failed ? "upstream_failed" : "", `${context}: ${text}`, caller.source, { method: request.method, ...(result.status === undefined ? {} : { status: result.status }) });
        } catch {
          deps.log("omb secrets: could not write the result of a fetch to the ledger");
        }
      };
      let sent: Awaited<ReturnType<typeof sendUpstream>>;
      try {
        const prepared = injectSecret(request, value);
        sent = await sendUpstream({
          fetch: deps.httpFetch ?? fetch, url: prepared.url, method: request.method, headers: prepared.headers,
          ...(request.body ? { body: request.body } : {}), timeoutMs: deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
        });
      } catch (error) {
        if (error instanceof UpstreamError) {
          outcome(error.reason, { failed: true });
          throw new SecretsError(EXIT.unavailable, "upstream_failed", `${ref}: ${error.message}. The secret was not shown.`);
        }
        outcome("not sent", {});
        throw error;
      }
      outcome(`status ${sent.status}`, { status: sent.status });
      const headers: Record<string, string> = {};
      for (const [name, text] of Object.entries(sent.headers)) headers[scrubText(name, needles, mark)] = scrubText(text, needles, mark);
      return { status: sent.status, headers, body: scrubBody(sent.body, needles, mark, sent.truncated).toString("base64"), truncated: sent.truncated };
    },

    /** Every scope must be covered before any value is read, so a refused run spends no single-release allow. */
    runCheck(input: { requests: ExecRequest[]; asker: Asker }, caller: Caller): Array<{ var: string; ref: string; value: string }> {
      checkAsker(input.asker);
      if (!input.requests.length || input.requests.length > 16) throw new SecretsError(EXIT.invalid, "invalid_request", "name from one to 16 variables");
      const vars = new Set<string>();
      const scopes = input.requests.map((request) => {
        checkRef(request.ref);
        if (vars.has(request.var)) throw new SecretsError(EXIT.invalid, "invalid_request", "a variable can be named once");
        vars.add(request.var);
        return scopeOf(request.ref, input.asker, checkExec(request.program, request.var));
      });
      for (const scope of scopes) {
        const found = grants.match(scope);
        if (found.kind === "block") {
          audit(caller, scope, input.asker, "deny", "blocked", input.asker.context ?? "blocked");
          throw new SecretsError(EXIT.refused, "blocked", `${scope.ref}: refused. A person blocked this agent from the secret. Do not try again.`);
        }
      }
      const covered: Array<{ scope: SecretScope; grant: Grant }> = [];
      const waiting: Array<Exclude<Eval, { kind: "covered" }>> = [];
      // One call counts once against the rate limit, however many of its variables are uncovered.
      let admitted: ReturnType<RateLimiter["admit"]> | undefined;
      const admit = () => (admitted ??= limiter.admit(input.asker.fingerprint));
      for (const scope of scopes) {
        const ev = evaluate(scope, input.asker, caller, "release", admit);
        if (ev.kind === "covered") covered.push({ scope, grant: ev.grant });
        else waiting.push(ev);
      }
      if (waiting.length) {
        const stopped = waiting.find((ev) => ev.kind !== "pending");
        if (stopped) throw refusal(stopped);
        const refs = waiting.flatMap((ev) => (ev.kind === "pending" ? [ev.request.ref] : []));
        throw new SecretsError(EXIT.pending, "approval_pending", `${refs.join(", ")}: approval is pending. ${REVIEW_MESSAGE}`);
      }
      const values = releaseAll(covered, input.asker, caller);
      return covered.map(({ scope }, index) => ({ var: scope.exec!.env, ref: scope.ref, value: values[index]! }));
    },

    /** Files a request ahead of the call that needs it. It never reads a value. */
    request(input: { ref: string; asker: Asker; exec?: { program: { path: string; hash: string }; env: string } }, caller: Caller): { status: "covered" | "pending" | "granted"; requestId?: string } {
      checkRef(input.ref);
      checkAsker(input.asker);
      const exec = input.exec ? checkExec(input.exec.program, input.exec.env) : undefined;
      const scope = scopeOf(input.ref, input.asker, exec);
      const ev = evaluate(scope, input.asker, caller, "request");
      if (ev.kind === "covered") {
        audit(caller, scope, input.asker, "check", "", input.asker.context ?? "request: already covered");
        return { status: "covered" };
      }
      if (ev.kind !== "pending") throw refusal(ev);
      return ev.autoGranted ? { status: "granted" } : { status: "pending", requestId: ev.request.id };
    },

    list() {
      const rows = new Map<string, { id: string; updatedAt: number }>();
      for (const secret of deps.vault.listSecrets(TEAM_READER)) {
        if (!REF_PATTERN.test(secret.name) || rows.has(secret.name)) continue;
        const known = lookup(secret.name);
        if (known) rows.set(secret.name, known);
      }
      return [...rows].map(([ref, known]) => describeRow(ref, known.id, known.updatedAt)).sort((a, b) => a.ref.localeCompare(b.ref));
    },

    describe(ref: string) {
      checkRef(ref);
      const known = lookup(ref);
      if (!known) throw new SecretsError(EXIT.missing, "no_such_secret", `${ref}: no such secret in the Vault.`);
      return describeRow(ref, known.id, known.updatedAt);
    },

    grantsFor(fingerprint: string): Grant[] {
      if (!FINGERPRINT_PATTERN.test(fingerprint)) throw new SecretsError(EXIT.invalid, "invalid_request", "fingerprint must be sha256: and 64 hex digits");
      return grants.list({ fingerprint });
    },

    auditFor(fingerprint: string, query: Omit<AuditQuery, "fingerprint">): AuditPage & { grants: Grant[] } {
      return { ...ledger.read({ ...query, fingerprint }), grants: this.grantsFor(fingerprint).filter((grant) => query.ref === undefined || grant.ref === query.ref) };
    },

    admin: {
      set(input: { ref: string; value: unknown; force?: boolean; bots?: unknown; profile?: unknown }): { ref: string; created: boolean } {
        checkRef(input.ref);
        const value = checkValue(input.value);
        const profile = checkProfile(input.profile, value);
        const bots = input.bots === undefined ? undefined : checkBots(input.bots);
        const all = deps.vault.listSecrets(TEAM_READER);
        const key = vaultNameKey(input.ref);
        const clash = all.find((secret) => secret.name !== input.ref && vaultNameKey(secret.name) === key);
        if (clash) throw new SecretsError(EXIT.exists, "exists", `another secret already has this name once case and punctuation are ignored: ${clash.name}`);
        const existing = lookup(input.ref);
        if (existing && input.force !== true) throw new SecretsError(EXIT.exists, "exists", `${input.ref} already exists; pass force to replace its value`);
        audit(adminCaller, { ref: input.ref, project: "", fingerprint: "", purpose: "" }, {}, "check", "", existing ? "admin:set (replace)" : "admin:set");
        if (existing) {
          deps.vault.updateSecret(existing.id, { value, ...(bots === undefined ? {} : { bots }), ...(input.profile == null ? {} : { profile: profile ?? {} }) });
          return { ref: input.ref, created: false };
        }
        deps.vault.saveSecret({ name: input.ref, value, source: "settings", bots: bots ?? [], ...(profile ? { profile } : {}) });
        return { ref: input.ref, created: true };
      },

      rotate(input: { ref: string; value: unknown; profile?: unknown }): { ref: string; rotatedAt: string } {
        checkRef(input.ref);
        const value = checkValue(input.value);
        const profile = checkProfile(input.profile, value);
        const known = lookup(input.ref);
        if (!known) throw new SecretsError(EXIT.missing, "no_such_secret", `${input.ref}: no such secret in the Vault.`);
        audit(adminCaller, { ref: input.ref, project: "", fingerprint: "", purpose: "" }, {}, "check", "", "admin:rotate");
        // A profile sent replaces the whole of it, an empty one included, so the person can clear allowedHosts.
        const updated = deps.vault.updateSecret(known.id, { value, ...(input.profile == null ? {} : { profile: profile ?? {} }) });
        return { ref: input.ref, rotatedAt: iso(updated?.updatedAt ?? now()) };
      },

      remove(ref: string): { ref: string; deleted: true; grantsRemoved: number } {
        checkRef(ref);
        const known = lookup(ref);
        if (!known) throw new SecretsError(EXIT.missing, "no_such_secret", `${ref}: no such secret in the Vault.`);
        audit(adminCaller, { ref, project: "", fingerprint: "", purpose: "" }, {}, "check", "", "admin:delete");
        deps.vault.removeSecret(known.id);
        const remains = lookup(ref) !== null;
        const grantsRemoved = remains ? 0 : grants.removeRef(ref);
        if (!remains) for (const request of pending.removeRef(ref)) deps.approvals.close(cardKey(request.id));
        return { ref, deleted: true, grantsRemoved };
      },

      /** The one place a value is shown to a person; the row is written first. */
      reveal(ref: string): { ref: string; value: string } {
        checkRef(ref);
        const known = lookup(ref);
        const value = known ? valueOf(known.id) : null;
        if (!known || value === null) throw new SecretsError(EXIT.missing, "no_such_secret", `${ref}: no such secret in the Vault.`);
        audit(adminCaller, { ref, project: "", fingerprint: "", purpose: "" }, {}, "allow", "", "admin:reveal");
        return { ref, value };
      },

      /** Writes an audit row for a Vault UI reveal by secret id (arbitrary name). */
      auditReveal(name: string, callerId = "admin"): void {
        audit({ id: callerId, source: "desktop" }, { ref: name, project: "", fingerprint: "", purpose: "" }, {}, "allow", "", "admin:reveal");
      },

      grant(input: {
        ref: string; fingerprint: string; project?: string; purpose?: string; state: "allow" | "block"; ttl?: string; persist?: boolean; once?: boolean;
        allowHosts?: string[]; exec?: { path: string; env: string; hash: string }; agentLabel?: string;
      }): Grant {
        checkRef(input.ref);
        const asker: Asker = { fingerprint: input.fingerprint, project: input.project ?? "default", purpose: input.purpose ?? "" };
        checkAsker(asker);
        if (input.state !== "allow" && input.state !== "block") throw new SecretsError(EXIT.invalid, "invalid_request", "state must be allow or block");
        const exec = input.exec ? checkExec(input.exec, input.exec.env) : undefined;
        const modes = [input.ttl !== undefined, input.persist === true, input.once === true].filter(Boolean).length;
        if (modes > 1 || (input.state === "block" && (input.persist || input.once))) throw new SecretsError(EXIT.invalid, "invalid_request", "name one of ttl, persist or once; a block takes only ttl");
        const ttlMs = input.ttl === undefined ? null : parseTtl(input.ttl);
        if (input.ttl !== undefined && ttlMs === null) throw new SecretsError(EXIT.invalid, "invalid_request", "ttl must be like 90m, 12h, 30d or 2w");
        if (input.allowHosts?.length && (input.state === "block" || exec)) throw new SecretsError(EXIT.invalid, "invalid_request", "allowHosts applies to an ordinary allow only");
        const hosts = input.allowHosts?.map((host) => normalizeHost(host));
        if (hosts?.some((host) => host === null)) throw new SecretsError(EXIT.invalid, "invalid_request", "allowHosts must be host names, optionally with a port");
        const label = input.agentLabel === undefined ? undefined : cleanText(input.agentLabel, 80);
        if (label === null) throw new SecretsError(EXIT.invalid, "invalid_request", "agentLabel is at most 80 printable characters");
        const expiresAt = input.persist || input.once ? undefined : ttlMs !== null ? now() + ttlMs : input.state === "allow" ? now() + DEFAULT_ALLOW_MS : undefined;
        audit(adminCaller, scopeOf(input.ref, asker, exec), {}, input.state === "allow" ? "allow" : "deny", "", `admin:grant ${input.state}`);
        const grant = grants.add({
          ...scopeOf(input.ref, asker, exec), state: input.state, createdBy: "admin", ...(expiresAt === undefined ? {} : { expiresAt }), ...(input.once ? { once: true } : {}),
          ...(label ? { agentLabel: label } : {}), ...(hosts?.length ? { allowHosts: hosts as string[] } : {}),
        });
        if (input.state === "allow") for (const request of pending.settle(scopeOf(input.ref, asker, exec))) deps.approvals.close(cardKey(request.id));
        return grant;
      },

      revoke(input: { fingerprint: string; all?: boolean; ref?: string; project?: string; purpose?: string; exec?: { path: string; env: string } }): { revoked: number } {
        if (!FINGERPRINT_PATTERN.test(input.fingerprint)) throw new SecretsError(EXIT.invalid, "invalid_request", "fingerprint must be sha256: and 64 hex digits");
        if (!input.all) checkRef(input.ref ?? "");
        if (input.exec && (!ENV_VAR_PATTERN.test(input.exec.env) || !input.exec.path)) throw new SecretsError(EXIT.invalid, "invalid_request", "name the program and the variable of the exec scope");
        audit(adminCaller, { ref: input.ref ?? "", project: input.project ?? "", fingerprint: input.fingerprint, purpose: input.purpose ?? "" }, {}, "check", "", input.all ? "admin:revoke all" : "admin:revoke");
        return { revoked: grants.revoke({ fingerprint: input.fingerprint, ...(input.all ? { all: true } : {}), ...(input.ref ? { ref: input.ref } : {}), ...(input.project ? { project: input.project } : {}), ...(input.purpose === undefined ? {} : { purpose: input.purpose }), ...(input.exec ? { exec: input.exec } : {}) }) };
      },

      pending: (): PendingRequest[] => pending.list(),

      approve(input: { id?: string; ref?: string; fingerprint?: string; project?: string; purpose?: string; env?: string; state: ApproveState; ttl?: string }): { answered: Array<{ id: string; ref: string; state: ApproveState }> } {
        if (!["deny", "once", "ttl", "persist"].includes(input.state)) throw new SecretsError(EXIT.invalid, "invalid_request", "state must be deny, once, ttl or persist");
        const ttlMs = input.ttl === undefined ? DEFAULT_ALLOW_MS : parseTtl(input.ttl);
        if (ttlMs === null) throw new SecretsError(EXIT.invalid, "invalid_request", "ttl must be like 90m, 12h, 30d or 2w");
        const matches = pending.list().filter((request) => (input.id === undefined || request.id === input.id) && (input.ref === undefined || request.ref === input.ref)
          && (input.fingerprint === undefined || request.fingerprint === input.fingerprint) && (input.project === undefined || request.project === input.project)
          && (input.purpose === undefined || request.purpose === input.purpose) && (input.env === undefined || (request.exec?.env ?? "") === input.env));
        if (matches.length === 0) throw new SecretsError(EXIT.invalid, "no_such_request", "no waiting request matches");
        if (matches.length > 1 && input.id === undefined) throw new SecretsError(EXIT.invalid, "invalid_request", `${matches.length} waiting requests match; name one by id`);
        const request = matches[0]!;
        settle(request.id, input.state === "deny" ? { state: "deny" } : { state: input.state, ttlMs }, adminCaller);
        return { answered: [{ id: request.id, ref: request.ref, state: input.state }] };
      },

      grants: (filter: { fingerprint?: string; ref?: string }): Grant[] => grants.list(filter),
      audit: (query: AuditQuery): AuditPage => ledger.read(query),
    },
  };
}

export type SecretsService = ReturnType<typeof createSecretsService>;
export type { ErrorCode, ExitCode };
