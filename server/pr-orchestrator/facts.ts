import { payloadOf, prSubjectOf } from "./projection.ts";
import { ciStatus, readiness } from "./readiness.ts";
import type { FactMap, FactName, FactValue, LedgerEntry, PrRecord, PrState, StepContext, TriggerName } from "./types.ts";
import { FACT_NAMES } from "./types.ts";
import type { PrCommon } from "./contract/omb-event.v1.ts";

function minutesOfDay(clock: string): number {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

function localMinutes(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  return part("hour") * 60 + part("minute");
}

function isQuietAt(current: number, start: number, end: number): boolean {
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

function mergeWindow(ctx: StepContext): { quietNow: boolean; minutesToWindow: number } {
  const quiet = ctx.config.merge.quietHours;
  if (quiet === null) return { quietNow: false, minutesToWindow: 0 };
  const start = minutesOfDay(quiet.start);
  const end = minutesOfDay(quiet.end);
  const at = (minutes: number) => localMinutes(ctx.now + minutes * 60_000, quiet.timeZone);
  if (!isQuietAt(at(0), start, end)) return { quietNow: false, minutesToWindow: 0 };
  // Wall-clock minutes are not elapsed minutes across a DST change: correct the guess by the local time it lands on.
  let minutes = Math.max(1, (end - at(0) + 1440) % 1440);
  for (let pass = 0; pass < 2; pass++) {
    const short = (end - at(minutes) + 1440) % 1440;
    if (short === 0) break;
    minutes = short <= 180 ? minutes + short : Math.max(1, minutes - (1440 - short));
  }
  // An end inside a skipped hour is never shown: take the first minute that is no longer quiet.
  for (let guard = 0; guard < 180 && isQuietAt(at(minutes), start, end); guard++) minutes += 1;
  return { quietNow: true, minutesToWindow: minutes };
}

function eventFacts(entry: LedgerEntry, facts: FactMap): void {
  if (entry.type !== "event.received") return;
  const event = entry.event;
  facts["event.connector"] = event.connector;
  facts["event.type"] = event.type;
  facts["event.subject.kind"] = event.subject.kind;
  if (!prSubjectOf(event)) return;
  const common = event.data as Partial<PrCommon>;
  facts["event.branch"] = common.branch ?? null;
  facts["event.baseRef"] = common.baseRef ?? null;
  facts["event.author"] = common.author ?? null;
  if (event.type === "pr.ci.finished") {
    const check = payloadOf(event, "pr.ci.finished").check;
    facts["event.check.source"] = check.source;
    facts["event.check.name"] = check.name;
  }
}

function triggerFacts(entry: LedgerEntry, record: PrRecord, facts: FactMap): void {
  if (entry.type === "event.received") {
    const event = entry.event;
    const headBound = event.type === "pr.ci.finished" || event.type === "pr.review.finished" || event.type === "pr.conflict.detected";
    const headSha = (event.data as Partial<PrCommon>).headSha ?? null;
    facts["trigger.isHead"] = headBound ? headSha !== null && headSha === record.headSha : true;
    if (event.type === "pr.ci.finished") facts["trigger.ci.status"] = payloadOf(event, "pr.ci.finished").check.status;
    if (event.type === "pr.review.finished") {
      const review = payloadOf(event, "pr.review.finished").review;
      facts["trigger.review.status"] = review.status;
      // A late review of an older commit is not about the head, even when it arrives while that head is current.
      if (review.reviewedSha !== record.headSha) facts["trigger.isHead"] = false;
    }
    return;
  }
  facts["trigger.isHead"] = true;
  if (entry.type === "timer.fired") facts["trigger.timer.kind"] = entry.kind;
  if (entry.type === "person.answered") facts["trigger.answer.kind"] = record.lastAnswer?.kind ?? null;
  if (entry.type === "run.finished") {
    facts["trigger.run.target"] = entry.target;
    facts["trigger.run.outcome"] = entry.outcome;
  }
  if (entry.type === "command.issued") facts["trigger.command.type"] = entry.command;
  if (entry.type === "command.finished") {
    facts["trigger.command.type"] = entry.command;
    facts["trigger.command.outcome"] = entry.result.outcome;
    facts["trigger.command.reason"] = entry.result.outcome === "succeeded" ? null : entry.result.reason;
  }
}

export function factsOf(input: {
  record: PrRecord | null; previousState: PrState | null; trigger: { name: TriggerName; entry: LedgerEntry }; ctx: StepContext;
}): FactMap {
  const { record, previousState, trigger, ctx } = input;
  const facts = Object.fromEntries(FACT_NAMES.map((name): [FactName, FactValue] => [name, null])) as FactMap;
  eventFacts(trigger.entry, facts);
  if (record === null) return facts;

  facts.state = record.state;
  facts.previousState = previousState;
  facts.draft = record.draft;
  facts.conflict = record.conflict;
  facts["run.activeCount"] = Object.keys(record.activeRuns).length;
  facts["owner.known"] = record.owner !== null;
  facts.pendingDecision = record.pendingDecision?.kind ?? null;
  triggerFacts(trigger.entry, record, facts);
  facts["ci.failingCount"] = ciStatus(record, ctx).failing.length;
  facts["review.staleForHead"] = record.review !== null && record.headSha !== null && record.review.reviewedSha !== record.headSha;
  const ready = readiness(record, ctx);
  facts["readiness.ready"] = ready.ready;
  facts["readiness.onlyForgeMissing"] = ready.onlyForgeMissing;
  const window = mergeWindow(ctx);
  facts["merge.quietNow"] = window.quietNow;
  facts["merge.minutesToWindow"] = window.minutesToWindow;
  return facts;
}
