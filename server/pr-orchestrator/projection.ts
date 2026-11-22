import type { OmbEvent, LedgerEntry, LedgerRow, PrRecord, Provider, TriggerName } from "./types.ts";
import { prKey } from "./types.ts";
import type { PrCommon, PrPayloadByType, PrSubject } from "./contract/omb-event.v1.ts";

export const PROJECTION_VERSION = 1;

export function emptyRecord(pr: { provider: Provider; repo: string; number: number; url: string | null }, at: number): PrRecord {
  return {
    key: prKey(pr.provider, pr.repo, pr.number), provider: pr.provider, repo: pr.repo, number: pr.number,
    url: pr.url, title: null, branch: null, baseRef: null, author: null,
    headSha: null, headSetAt: null, draft: false,
    state: "open", stateSince: at,
    owner: null, checks: {}, review: null, forge: null, conflict: false,
    activeRuns: {}, pendingDecision: null, lastAnswer: null,
    createdAt: at, updatedAt: at, lastSeq: 0,
  };
}

/** The PR subject of an event, or null for any other subject. */
export function prSubjectOf(event: OmbEvent): PrSubject | null {
  const subject = event.subject;
  return subject.kind === "pr" && "forge" in subject ? subject : null;
}

/** The contract payload of an event of a known PR type. */
export function payloadOf<T extends keyof PrPayloadByType>(event: OmbEvent, _type: T): PrPayloadByType[T] {
  return event.data as PrPayloadByType[T];
}

function commonOf(event: OmbEvent): Partial<PrCommon> {
  return event.data as Partial<PrCommon>;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isHeadEvent(record: PrRecord, headSha: string | null): boolean {
  return headSha !== null && headSha === record.headSha;
}

function newHead(record: PrRecord, sha: string | null, at: number): void {
  if (sha === null || sha === record.headSha) return;
  record.headSha = sha;
  record.headSetAt = at;
  record.checks = {};
  record.forge = null;
  record.conflict = false;
}

function createRecord(entry: LedgerEntry, at: number): PrRecord {
  if (entry.type === "event.received") {
    const subject = prSubjectOf(entry.event);
    if (!subject) throw new Error("not a PR event");
    const record = emptyRecord({ provider: subject.forge, repo: subject.repo, number: subject.number, url: text(commonOf(entry.event).url) }, at);
    newHead(record, text(commonOf(entry.event).headSha), at);
    return record;
  }
  if (entry.type === "owner.bound") return emptyRecord(entry.pr, at);
  throw new Error("ledger row for an unknown PR");
}

function foldEvent(record: PrRecord, event: OmbEvent, at: number): void {
  if (!prSubjectOf(event)) throw new Error("not a PR event");
  const common = commonOf(event);
  record.url = text(common.url) ?? record.url;
  record.branch = text(common.branch) ?? record.branch;
  record.baseRef = text(common.baseRef) ?? record.baseRef;
  record.author = text(common.author) ?? record.author;
  // As createRecord does for a first event: a record that owner.bound opened learns its head from any PR event.
  if (record.headSha === null && event.type !== "pr.pushed") newHead(record, text(common.headSha), at);
  switch (event.type) {
    case "pr.opened": {
      const data = payloadOf(event, "pr.opened");
      record.url = text(data.url) ?? record.url;
      record.title = data.title;
      record.draft = data.draft;
      newHead(record, data.headSha, at);
      if (data.reopened === true) record.forge = null;
      return;
    }
    case "pr.pushed":
      newHead(record, payloadOf(event, "pr.pushed").after, at);
      return;
    case "pr.ci.finished": {
      const data = payloadOf(event, "pr.ci.finished");
      if (!isHeadEvent(record, data.headSha)) return;
      const c = data.check;
      const key = c.scope === "job" ? `${c.source}/job:${c.name}` : `${c.source}/${c.name}`;
      record.checks[key] = {
        key, source: c.source, name: c.name, scope: c.scope, status: c.status, url: c.url,
        runId: c.runId ?? null, failedJobs: c.failedJobs, headSha: record.headSha as string, at,
      };
      if (c.status === "passed" && (c.scope === "workflow" || c.scope === "suite")) {
        for (const [other, fact] of Object.entries(record.checks)) {
          if (fact.scope === "job" && fact.source === c.source) delete record.checks[other];
        }
      }
      return;
    }
    case "pr.review.finished": {
      const r = payloadOf(event, "pr.review.finished").review;
      // A late review of an older commit never replaces one that covers the head.
      if (record.headSha !== null && record.review?.reviewedSha === record.headSha && r.reviewedSha !== record.headSha) return;
      record.review = {
        status: r.status, reviewedSha: r.reviewedSha, rounds: r.rounds, maxRounds: r.maxRounds,
        items: r.items, commentId: r.commentId, commentUrl: r.commentUrl, at,
      };
      return;
    }
    case "pr.conflict.detected":
      if (isHeadEvent(record, payloadOf(event, "pr.conflict.detected").headSha)) record.conflict = true;
      return;
    default:
      return;
  }
}

function foldEntry(record: PrRecord, entry: LedgerEntry, at: number): void {
  switch (entry.type) {
    case "event.received":
      foldEvent(record, entry.event, at);
      return;
    case "owner.bound":
      record.owner = entry.owner;
      return;
    case "run.finished": {
      const active = record.activeRuns[entry.target];
      if (active && (active.runRef === null || active.runRef === entry.runRef)) delete record.activeRuns[entry.target];
      return;
    }
    case "person.answered":
      record.lastAnswer = {
        decisionId: entry.decisionId, answer: entry.answer, at,
        kind: record.pendingDecision?.decisionId === entry.decisionId ? record.pendingDecision.kind : null,
      };
      if (record.pendingDecision?.decisionId === entry.decisionId) record.pendingDecision = null;
      return;
    case "command.gated":
      if (entry.payload.type === "RunWorkflow") {
        record.activeRuns[entry.payload.guard] = { commandId: entry.commandId, since: at, status: "awaiting_approval", runRef: null };
      }
      return;
    case "command.issued":
      if (entry.payload.type === "RunWorkflow") {
        record.activeRuns[entry.payload.guard] = { commandId: entry.commandId, since: at, status: "starting", runRef: null };
      }
      return;
    case "command.finished":
      foldCommandFinished(record, entry, at);
      return;
    case "state.changed":
      record.state = entry.to;
      record.stateSince = at;
      return;
    default:
      return;
  }
}

function foldCommandFinished(record: PrRecord, entry: Extract<LedgerEntry, { type: "command.finished" }>, at: number): void {
  const { payload, result } = entry;
  if (record.pendingDecision?.gatedCommandId === entry.commandId) record.pendingDecision = null;
  if (payload.type === "RunWorkflow") {
    const current = record.activeRuns[payload.guard];
    if (!current || current.commandId !== entry.commandId) return;
    if (result.outcome === "succeeded" && result.detail && "runRef" in result.detail) {
      record.activeRuns[payload.guard] = { ...current, status: "running", runRef: result.detail.runRef };
    } else {
      delete record.activeRuns[payload.guard];
    }
    return;
  }
  if (result.outcome !== "succeeded") return;
  if (payload.type === "AskPerson") {
    record.pendingDecision = {
      decisionId: payload.decisionId, kind: payload.kind, askedAt: at, commandId: entry.commandId, gatedCommandId: payload.gated?.commandId ?? null,
    };
  } else if (payload.type === "RefreshDetails" && result.detail && "forge" in result.detail) {
    // A late refresh of an older head never replaces the facts of the current one.
    if (record.headSha !== null && record.forge?.headSha === record.headSha && result.detail.forge.headSha !== record.headSha) return;
    record.forge = { ...result.detail.forge, at };
    if (record.forge.headSha === record.headSha) record.conflict = record.forge.blockers.includes("conflict");
  }
}

/** Returns a new record; the given one is never changed. */
export function fold(record: PrRecord | null, row: LedgerRow): PrRecord {
  const next = record ? structuredClone(record) : createRecord(row.entry, row.at);
  foldEntry(next, row.entry, row.at);
  next.lastSeq = row.seq;
  next.updatedAt = row.at;
  return next;
}

export function foldAll(rows: LedgerRow[]): PrRecord | null {
  return rows.reduce<PrRecord | null>((record, row) => fold(record, row), null);
}

export function triggerOf(entry: LedgerEntry): TriggerName | null {
  switch (entry.type) {
    case "event.received":
      return entry.event.type;
    case "owner.bound":
    case "run.finished":
    case "person.answered":
    case "timer.fired":
    case "command.finished":
    case "command.issued":
      return entry.type;
    default:
      return null;
  }
}
