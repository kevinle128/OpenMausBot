import type { CiCheck, FailedJob, Forge, OmbEventV1, ReviewItem } from "../contract/omb-event.v1.ts";
import type { LedgerEntry, LedgerRow, OmbEvent, OrchestratorConfig, PrRecord, RepoConfig, StepContext, SubjectKey } from "../types.ts";
import { orchestratorConfigSchema, resolveForRepo } from "../config.ts";
import { prKey } from "../types.ts";

export const T0 = Date.UTC(2026, 10, 22, 0, 0, 0);
export const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export interface PrTarget { forge?: Forge; repo?: string; number?: number }
type Opts<T> = PrTarget & { head?: string | null; branch?: string | null; baseRef?: string | null; author?: string | null; url?: string | null; id?: string } & T;

let counter = 0;

function envelope(type: string, target: PrTarget, data: object, id?: string): OmbEvent {
  const forge = target.forge ?? "github";
  const repo = target.repo ?? "acme/widgets";
  const number = target.number ?? 1;
  const connector = `${forge}-event`;
  const eventId = id ?? `evt-${++counter}`;
  const event: OmbEventV1 = {
    v: 1, id: eventId, source: { connector }, type, occurredAt: new Date(T0).toISOString(),
    subject: { kind: "pr", forge, repo, number }, data,
  };
  return { ...event, connector, key: `${connector}:${eventId}`, subjectKey: prKey(forge, repo, number), rawRef: null };
}

function common<T>(o: Opts<T>) {
  const url = o.url === undefined ? `https://example.test/${o.repo ?? "acme/widgets"}/pull/${o.number ?? 1}` : o.url;
  return {
    headSha: o.head === undefined ? SHA_A : o.head,
    baseRef: o.baseRef === undefined ? "main" : o.baseRef,
    branch: o.branch === undefined ? "feature" : o.branch,
    author: o.author === undefined ? "dev" : o.author,
    url,
  };
}

function asJobs(jobs: Array<string | FailedJob> | undefined): FailedJob[] {
  return (jobs ?? []).map((job, index) => typeof job === "string" ? { id: `job-${index}`, name: job, url: `https://example.test/job/${index}` } : job);
}

/** Builders for conforming contract events as OMB stores them. */
export const ev = {
  opened: (o: Opts<{ title?: string; draft?: boolean; reopened?: boolean }> = {}) =>
    envelope("pr.opened", o, { ...common(o), title: o.title ?? "A change", draft: o.draft ?? false, reopened: o.reopened ?? false }, o.id),
  pushed: (o: Opts<{ before?: string | null; after?: string }> = {}) => {
    const after = o.after ?? o.head ?? SHA_B;
    return envelope("pr.pushed", o, { ...common({ ...o, head: o.head === undefined ? after : o.head }), before: o.before ?? SHA_A, after }, o.id);
  },
  ciFinished: (o: Opts<{ status?: CiCheck["status"]; name?: string; source?: string; scope?: CiCheck["scope"]; runId?: string; failedJobs?: Array<string | FailedJob> }> = {}) => {
    const check: CiCheck = {
      source: o.source ?? "github-actions", scope: o.scope ?? "workflow", name: o.name ?? "ci", status: o.status ?? "passed",
      url: "https://example.test/run/1", failedJobs: asJobs(o.failedJobs),
      ...(o.runId === undefined ? {} : { runId: o.runId }),
    };
    return envelope("pr.ci.finished", o, { ...common(o), check }, o.id);
  },
  reviewFinished: (o: Opts<{ status?: "success" | "needs-person" | "failed"; reviewedSha?: string; items?: ReviewItem[] }> = {}) =>
    envelope("pr.review.finished", o, {
      ...common(o),
      review: {
        source: "ocr", status: o.status ?? "success", reviewedSha: o.reviewedSha ?? o.head ?? SHA_A, rounds: 1, maxRounds: 3,
        items: o.items ?? [], commenter: "ocr-bot", commentId: "c1", commentUrl: "https://example.test/comment/1",
      },
    }, o.id),
  conflict: (o: Opts<object> = {}) => envelope("pr.conflict.detected", o, { ...common(o), conflict: { state: "dirty" } }, o.id),
  comment: (o: Opts<{ body?: string }> = {}) =>
    envelope("pr.comment.created", o, {
      ...common(o),
      comment: { id: "c2", url: "https://example.test/comment/2", commenter: "dev", edited: false, body: o.body ?? "hello", bodyTruncated: false },
    }, o.id),
  merged: (o: Opts<object> = {}) => envelope("pr.merged", o, { ...common(o), merge: { commitSha: SHA_B, mergedBy: "dev" } }, o.id),
  closed: (o: Opts<object> = {}) => envelope("pr.closed", o, { ...common(o), closedBy: "dev" }, o.id),
};

export const DEFAULT_PR_KEY: SubjectKey = prKey("github", "acme/widgets", 1);

/** Wraps an event as an `event.received` entry, or takes any ledger entry as it is. */
export function row(input: LedgerEntry | OmbEvent, seq: number, at: number = T0 + seq * 1000, subjectKey?: SubjectKey): LedgerRow {
  const entry: LedgerEntry = "subject" in input ? { type: "event.received", event: input, receivedSeq: seq } : input;
  const key = subjectKey ?? (entry.type === "event.received" ? entry.event.subjectKey : DEFAULT_PR_KEY);
  return { seq, subjectKey: key, at, configVersion: "test", causationSeq: null, entry };
}

export const DEFAULT_CONFIG: OrchestratorConfig = orchestratorConfigSchema.parse({ enabled: true });

type ConfigPatch = {
  [K in keyof RepoConfig]?: RepoConfig[K] extends readonly unknown[] ? RepoConfig[K] : RepoConfig[K] extends object | null ? Partial<NonNullable<RepoConfig[K]>> | null : RepoConfig[K];
};

/** A step context with the default config; each given top-level key is merged one level deep, and arrays and null replace. */
export function ctxFor(patch: ConfigPatch = {}, now: number = T0): StepContext {
  const config: Record<string, unknown> = structuredClone(resolveForRepo(DEFAULT_CONFIG, "github", "acme/widgets"));
  for (const [key, value] of Object.entries(patch)) {
    const current = config[key];
    const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    config[key] = plain(value) && plain(current) ? { ...current, ...value } : value;
  }
  return { now, config: config as unknown as RepoConfig, configVersion: "test" };
}

export function withRecord(record: PrRecord, patch: Partial<PrRecord>): PrRecord {
  return { ...structuredClone(record), ...patch };
}

export function fakeClock(start: number = T0): { now(): number; set(at: number): void; advance(ms: number): void } {
  let current = start;
  return { now: () => current, set: (at) => { current = at; }, advance: (ms) => { current += ms; } };
}

export function counterIds(prefix = "id"): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}
