import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { SecretsError } from "./types.ts";

export const AUDIT_DIR = "secret-audit";
const MONTH_FILE = /^(\d{4}-\d{2})\.ndjson$/;
const MAX_MONTHS = 12;
export const AUDIT_PAGE = 100;
export const AUDIT_PAGE_MAX = 500;

export type AuditDecision = "allow" | "deny" | "check";
export type AuditSource = "adapter" | "cli" | "desktop";
export type AuditErrorCode = "" | "approval_pending" | "rate_limited" | "blocked" | "host_not_allowed" | "no_such_secret" | "denied" | "approve_refused" | "upstream_failed";

/** One decision. It never holds a value, and never a hash or a part of one. */
export interface AuditRow {
  id: string;
  at: string;
  decision: AuditDecision;
  source: AuditSource;
  ref: string;
  project: string;
  purpose: string;
  fingerprint: string;
  agentLabel: string;
  sessionId: string;
  context: string;
  errorCode: AuditErrorCode;
  short: string;
  /** The token session that made the call; `loopback` for the owner's own machine. */
  caller: string;
  destHost?: string;
  agentId?: string;
  /** Of a fetch: the HTTP method, and the status the destination answered (absent when it did not). Never a URL path, query or body. */
  method?: string;
  status?: number;
}

export type NewAuditRow = Omit<AuditRow, "id" | "at" | "short"> & { fingerprint: string };

export interface AuditQuery {
  ref?: string;
  fingerprint?: string;
  since?: number;
  decision?: "allow" | "deny" | "block" | "check";
  source?: AuditSource;
  limit?: number;
  cursor?: string;
}

export interface AuditPage {
  entries: AuditRow[];
  hasMore: boolean;
  limit: number;
  nextCursor: string | null;
}

const monthOf = (at: Date): string => at.toISOString().slice(0, 7);

/**
 * Append-only NDJSON, one file per UTC month. An append that fails throws, so a release whose row cannot be written
 * never happens (unlike the decision log, which must never fail the decision it records).
 */
export class AuditLedger {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.dir = join(options.dataDir, AUDIT_DIR);
    this.now = options.now ?? Date.now;
  }

  append(row: NewAuditRow): AuditRow {
    const at = new Date(this.now());
    const full: AuditRow = { ...row, id: `${at.getTime().toString(36).padStart(9, "0")}-${randomUUID().slice(0, 8)}`, at: at.toISOString(), short: row.fingerprint.replace(/^sha256:/, "").slice(0, 12) };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const file = join(this.dir, `${monthOf(at)}.ndjson`);
      const fresh = !existsSync(file);
      appendFileSync(file, `${JSON.stringify(full)}\n`, { mode: 0o600 });
      if (fresh) chmodSync(file, 0o600);
    } catch {
      throw new SecretsError(5, "store_unavailable", "the audit ledger could not be written, so nothing was released");
    }
    return full;
  }

  /** Newest first. The cursor is the id of the last row of the page before. */
  read(query: AuditQuery = {}): AuditPage {
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? AUDIT_PAGE)), AUDIT_PAGE_MAX);
    let files: string[] = [];
    try {
      files = existsSync(this.dir) ? readdirSync(this.dir).filter((name) => MONTH_FILE.test(name)).sort().reverse().slice(0, MAX_MONTHS) : [];
    } catch {
      throw new SecretsError(5, "store_unavailable", "the audit ledger could not be read");
    }
    const matches: AuditRow[] = [];
    let skipping = query.cursor !== undefined;
    for (const name of files) {
      let rows: AuditRow[];
      try {
        rows = readFileSync(join(this.dir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as AuditRow).reverse();
      } catch {
        throw new SecretsError(5, "store_unavailable", "the audit ledger could not be read");
      }
      for (const row of rows) {
        if (skipping) {
          if (row.id === query.cursor) skipping = false;
          continue;
        }
        if (query.ref !== undefined && row.ref !== query.ref) continue;
        if (query.fingerprint !== undefined && row.fingerprint !== query.fingerprint) continue;
        if (query.since !== undefined && Date.parse(row.at) < query.since) continue;
        if (query.decision !== undefined && row.decision !== (query.decision === "block" ? "deny" : query.decision)) continue;
        if (query.source !== undefined && row.source !== query.source) continue;
        matches.push(row);
        if (matches.length > limit) break;
      }
      if (matches.length > limit) break;
    }
    const entries = matches.slice(0, limit);
    return { entries, hasMore: matches.length > limit, limit, nextCursor: matches.length > limit ? entries[entries.length - 1]!.id : null };
  }
}
