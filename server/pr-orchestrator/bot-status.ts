import { ciStatus, readiness } from "./readiness.ts";
import type { PrRecord, ReadinessGap, StepContext } from "./types.ts";

/** The PR facts a bot reads. `asOf` is the clock time of this read, as an ISO string. */
export interface PrStatusForBot {
  key: PrRecord["key"];
  provider: PrRecord["provider"];
  repo: string;
  number: number;
  url: string | null;
  title: string | null;
  author: string | null;
  branch: string | null;
  baseRef: string | null;
  draft: boolean;
  headSha: string | null;
  state: PrRecord["state"];
  checks: Array<{ key: string; status: PrRecord["checks"][string]["status"]; url: string }>;
  ci: { settled: boolean; failing: string[]; optionalFailing: string[]; required: string[] | "observed" };
  review: { status: NonNullable<PrRecord["review"]>["status"]; reviewedSha: string; onHead: boolean; rounds: number; commentUrl: string } | null;
  conflict: boolean;
  /** Null when no forge read matches the current head, or the forge has not computed it. */
  mergeable: boolean | null;
  owner: { runtime: string; agentId: string; cwd: string | null } | null;
  gaps: ReadinessGap[];
  asOf: string;
}

const FORGE_READ_GAPS = new Set<ReadinessGap>(["forge_stale", "not_mergeable"]);

function mergeableOnHead(record: PrRecord): boolean | null {
  if (record.forge === null || record.headSha === null || record.forge.headSha !== record.headSha) return null;
  return record.forge.mergeable;
}

/** CI and readiness for one ledger record. No I/O. */
export function prStatusForBot(record: PrRecord, ctx: StepContext, now: number): PrStatusForBot {
  const ci = ciStatus(record, ctx);
  const review = record.review;
  const owner = record.owner;
  return {
    key: record.key, provider: record.provider, repo: record.repo, number: record.number,
    url: record.url, title: record.title, author: record.author, branch: record.branch, baseRef: record.baseRef,
    draft: record.draft, headSha: record.headSha, state: record.state,
    checks: Object.values(record.checks).map(check => ({ key: check.key, status: check.status, url: check.url })),
    ci: {
      settled: ci.settled,
      failing: ci.failing.map(check => check.key),
      optionalFailing: ci.optionalFailing.map(check => check.key),
      required: ci.required,
    },
    review: review === null ? null : {
      status: review.status, reviewedSha: review.reviewedSha, onHead: review.reviewedSha === record.headSha,
      rounds: review.rounds, commentUrl: review.commentUrl,
    },
    conflict: record.conflict,
    mergeable: mergeableOnHead(record),
    owner: owner === null ? null : { runtime: owner.runtime, agentId: owner.agentId, cwd: owner.cwd ?? null },
    // A missing forge read is mergeable null. These two gaps repeat that fact, so they are left out.
    gaps: readiness(record, ctx).gaps.filter(gap => !FORGE_READ_GAPS.has(gap)),
    asOf: new Date(now).toISOString(),
  };
}
