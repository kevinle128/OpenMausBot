import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import { readStateFile, writeStateFile } from "./json-file.ts";
import { scopeKey, type SecretScope } from "./types.ts";

export const REQUESTS_FILE = "secret-requests.json";
export const RATE_LIMIT = 12;
export const RATE_WINDOW_MS = 60_000;
export const COOLDOWN_MS = 5 * 60_000;
const MAX_REQUESTS = 200;

const requestSchema = z.object({
  id: z.string().min(1),
  ref: z.string().min(1),
  project: z.string(),
  fingerprint: z.string().min(1),
  purpose: z.string(),
  exec: z.object({ path: z.string().min(1), env: z.string().min(1), hash: z.string().min(1) }).optional(),
  agentLabel: z.string().optional(),
  sessionId: z.string().optional(),
  /** The Paseo agent the caller named. Attribution only; it never authorizes anything. */
  agentId: z.string().optional(),
  agentTitle: z.string().optional(),
  cwd: z.string().optional(),
  count: z.number().int().min(1),
  firstSeen: z.number(),
  lastSeen: z.number(),
});

const fileSchema = z.object({ version: z.literal(1), requests: z.array(requestSchema) });

export type PendingRequest = z.infer<typeof requestSchema>;
export interface RequestDetails {
  agentLabel?: string;
  sessionId?: string;
  agentId?: string;
  agentTitle?: string;
  cwd?: string;
}

/** Requests that no grant covered. A repeat of one scope is one entry with a higher count. */
export class PendingStore {
  private readonly file: string;
  private readonly now: () => number;
  private rows: PendingRequest[] | null = null;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, REQUESTS_FILE);
    this.now = options.now ?? Date.now;
  }

  private load(): PendingRequest[] {
    this.rows ??= readStateFile(this.file, fileSchema, { version: 1 as const, requests: [] }).requests;
    return this.rows;
  }

  private save(next: PendingRequest[]): void {
    const kept = next.slice(-MAX_REQUESTS);
    writeStateFile(this.file, { version: 1, requests: kept });
    this.rows = kept;
  }

  record(scope: SecretScope, details: RequestDetails): { request: PendingRequest; created: boolean } {
    const rows = this.load();
    const key = scopeKey(scope);
    const at = this.now();
    const same = rows.find((row) => scopeKey(row) === key);
    if (same) {
      const request: PendingRequest = { ...same, ...definedOnly(details), count: same.count + 1, lastSeen: at };
      this.save(rows.map((row) => (row === same ? request : row)));
      return { request, created: false };
    }
    const request: PendingRequest = {
      id: randomUUID(), ref: scope.ref, project: scope.project, fingerprint: scope.fingerprint, purpose: scope.purpose,
      ...(scope.exec ? { exec: { ...scope.exec } } : {}), ...definedOnly(details), count: 1, firstSeen: at, lastSeen: at,
    };
    this.save([...rows, request]);
    return { request, created: true };
  }

  list(): PendingRequest[] {
    return [...this.load()];
  }

  get(id: string): PendingRequest | undefined {
    return this.load().find((row) => row.id === id);
  }

  /** Every request the scope covers once answered; an ordinary scope answers only ordinary requests. */
  settle(scope: SecretScope): PendingRequest[] {
    const rows = this.load();
    const key = scopeKey(scope);
    const gone = rows.filter((row) => scopeKey(row) === key);
    if (gone.length) this.save(rows.filter((row) => !gone.includes(row)));
    return gone;
  }

  remove(id: string): PendingRequest | undefined {
    const rows = this.load();
    const gone = rows.find((row) => row.id === id);
    if (gone) this.save(rows.filter((row) => row !== gone));
    return gone;
  }

  removeRef(ref: string): PendingRequest[] {
    const rows = this.load();
    const gone = rows.filter((row) => row.ref === ref);
    if (gone.length) this.save(rows.filter((row) => row.ref !== ref));
    return gone;
  }
}

function definedOnly(details: RequestDetails): RequestDetails {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined && value !== "")) as RequestDetails;
}

/** 12 requests a minute from one caller that holds no grant, then five minutes of refusal. Held in memory: a restart clears it. */
export class RateLimiter {
  private readonly now: () => number;
  private readonly seen = new Map<string, { times: number[]; until: number }>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Counts one request. `retryAfterMs` is set when the caller is in its cool-down (this request included). */
  admit(fingerprint: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const at = this.now();
    const entry = this.seen.get(fingerprint) ?? { times: [], until: 0 };
    if (entry.until > at) return { ok: false, retryAfterMs: entry.until - at };
    entry.times = entry.times.filter((time) => at - time < RATE_WINDOW_MS);
    entry.times.push(at);
    if (entry.times.length > RATE_LIMIT) {
      entry.times = [];
      entry.until = at + COOLDOWN_MS;
      this.seen.set(fingerprint, entry);
      return { ok: false, retryAfterMs: COOLDOWN_MS };
    }
    this.seen.set(fingerprint, entry);
    if (this.seen.size > 1_000) for (const [key, one] of this.seen) if (one.until <= at && one.times.every((time) => at - time >= RATE_WINDOW_MS)) this.seen.delete(key);
    return { ok: true };
  }
}
