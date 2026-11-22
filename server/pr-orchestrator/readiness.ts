import { globMatch } from "./glob.ts";
import type { CheckFact, PrRecord, ReadinessGap, StepContext } from "./types.ts";
import { READINESS_GAPS } from "./types.ts";

export function unitsOf(check: CheckFact): string[] {
  return check.failedJobs.length > 0 ? check.failedJobs.map(job => job.name) : [check.key];
}

export function isExcused(unit: string, record: PrRecord, ctx: StepContext): boolean {
  return ctx.config.readiness.compareBase && record.forge !== null && record.forge.headSha === record.headSha && record.forge.baseFailing.includes(unit);
}

function forgeIsFresh(record: PrRecord): boolean {
  return record.forge !== null && record.headSha !== null && record.forge.headSha === record.headSha;
}

export function ciStatus(record: PrRecord, ctx: StepContext): { settled: boolean; failing: CheckFact[]; optionalFailing: CheckFact[]; required: string[] | "observed" } {
  const checks = Object.values(record.checks);
  const configured = ctx.config.readiness.requiredChecks;
  const forgeList = forgeIsFresh(record) ? record.forge?.requiredChecks ?? null : null;
  let required: string[] | "observed" = "observed";
  let inRequired = (_check: CheckFact) => true;
  if (configured.length > 0) {
    required = configured;
    inRequired = check => configured.some(glob => globMatch(glob, check.key));
  } else if (forgeList !== null) {
    required = forgeList;
    inRequired = check => forgeList.includes(check.key);
  }
  const failed = checks.filter(check => (check.status === "failed" || check.status === "cancelled") && unitsOf(check).some(unit => !isExcused(unit, record, ctx)));
  const failing = failed.filter(inRequired);
  const optionalFailing = failed.filter(check => !inRequired(check));
  if (configured.length > 0) {
    return { settled: configured.every(glob => checks.some(check => globMatch(glob, check.key))), failing, optionalFailing, required };
  }
  if (forgeList !== null) {
    return { settled: forgeList.every(key => Object.hasOwn(record.checks, key)), failing, optionalFailing, required };
  }
  const hasResult = checks.some(check => check.scope !== "job");
  return { settled: hasResult && failing.length === 0, failing, optionalFailing, required };
}

export function readiness(record: PrRecord, ctx: StepContext): { ready: boolean; gaps: ReadinessGap[]; onlyForgeMissing: boolean } {
  const cfg = ctx.config.readiness;
  const found = new Set<ReadinessGap>();
  if (record.draft) found.add("draft");
  if (record.headSha === null) found.add("head_unknown");
  const ci = ciStatus(record, ctx);
  if (!ci.settled || ci.failing.length > 0) found.add("checks_not_passed");
  if (record.conflict) found.add("conflict");
  const review = record.review;
  if (
    record.pendingDecision !== null
    || (cfg.requireReview && review?.status !== "success")
    || (cfg.requireReviewedHead && review?.reviewedSha !== record.headSha)
  ) found.add("review_not_passed");
  const fresh = forgeIsFresh(record);
  if (!fresh) found.add("forge_stale");
  if (cfg.requireMergeable && !(fresh && record.forge?.mergeable === true)) found.add("not_mergeable");
  const gaps = READINESS_GAPS.filter(gap => found.has(gap));
  const onlyForgeMissing = found.has("forge_stale") && gaps.every(gap => gap === "forge_stale" || gap === "not_mergeable");
  return { ready: gaps.length === 0, gaps, onlyForgeMissing };
}
