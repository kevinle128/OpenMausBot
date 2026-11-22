/**
 * The OMB event contract, version 1.
 *
 * OpenMausBot owns this contract and every connector must emit it. Version 1 may gain optional fields and new
 * event types. Removing or renaming a field or a type needs version 2.
 */
import schema from "./omb-event.v1.json" with { type: "json" };

export type Forge = "github" | "gitlab";

export interface PrSubject { kind: "pr"; forge: Forge; repo: string; number: number }
export interface GenericSubject { kind: string; id: string; label?: string }

export interface OmbEventV1 {
  v: 1;
  /** Stable across retries of the same fact; the dedupe key within its connector. */
  id: string;
  /** The connector definition id that produced the event. */
  source: { connector: string };
  type: string;
  /** RFC 3339, UTC. */
  occurredAt: string;
  subject: PrSubject | GenericSubject;
  correlation?: Record<string, string>;
  data: object;
}

export interface FailedJob { id: string; name: string; url: string; stage?: string; conclusion?: string }

export interface CiCheck {
  source: string;
  scope: "workflow" | "suite" | "job" | "status" | "pipeline";
  name: string;
  status: "passed" | "failed" | "cancelled" | "skipped";
  url: string;
  runId?: string;
  failedJobs: FailedJob[];
}

export interface ReviewItem { round: number; scope: "full" | "commit"; real: number; fixed: number; unresolved: number }

export interface ReviewSummary {
  source: string;
  status: "success" | "needs-person" | "failed";
  reviewedSha: string;
  rounds: number;
  maxRounds: number;
  items: ReviewItem[];
  commenter: string;
  commentId: string;
  commentUrl: string;
}

export interface CommentPayload {
  id: string;
  url: string;
  commenter: string;
  edited: boolean;
  /** Cut to 32768 bytes. */
  body: string;
  bodyTruncated: boolean;
  markerError?: string;
}

/** Fields that every pr.* payload carries; each is null when the forge does not say. */
export interface PrCommon {
  headSha: string | null;
  baseRef: string | null;
  branch: string | null;
  author: string | null;
  url: string | null;
}

export interface PrOpenedData extends PrCommon { title: string; draft: boolean; reopened: boolean }
export interface PrPushedData extends PrCommon { before: string | null; after: string }
export interface PrCiFinishedData extends PrCommon { check: CiCheck }
export interface PrReviewFinishedData extends PrCommon { review: ReviewSummary }
export interface PrCommentCreatedData extends PrCommon { comment: CommentPayload }
export interface PrConflictDetectedData extends PrCommon { conflict: { state: string } }
export interface PrMergedData extends PrCommon { merge: { commitSha: string | null; mergedBy: string | null } }
export interface PrClosedData extends PrCommon { closedBy: string | null }

export interface PrPayloadByType {
  "pr.opened": PrOpenedData;
  "pr.pushed": PrPushedData;
  "pr.ci.finished": PrCiFinishedData;
  "pr.review.finished": PrReviewFinishedData;
  "pr.comment.created": PrCommentCreatedData;
  "pr.conflict.detected": PrConflictDetectedData;
  "pr.merged": PrMergedData;
  "pr.closed": PrClosedData;
}

/** The event types of version 1. A new type is one entry here and one schema under `$defs.payloads`. */
export const OMB_EVENT_TYPES = {
  "pr.opened": { domain: "pr", subjectKind: "pr", title: "PR opened", description: "A pull request or merge request was opened or opened again." },
  "pr.pushed": { domain: "pr", subjectKind: "pr", title: "PR pushed", description: "New commits were pushed to the head branch of a pull request." },
  "pr.ci.finished": { domain: "pr", subjectKind: "pr", title: "CI finished", description: "A check, workflow, suite, job or pipeline of a pull request ended." },
  "pr.review.finished": { domain: "pr", subjectKind: "pr", title: "Review finished", description: "An automated review chain ended on a pull request." },
  "pr.comment.created": { domain: "pr", subjectKind: "pr", title: "PR comment", description: "A comment was written or edited on a pull request." },
  "pr.conflict.detected": { domain: "pr", subjectKind: "pr", title: "Conflict detected", description: "A pull request cannot merge because of a conflict with its base." },
  "pr.merged": { domain: "pr", subjectKind: "pr", title: "PR merged", description: "A pull request was merged." },
  "pr.closed": { domain: "pr", subjectKind: "pr", title: "PR closed", description: "A pull request was closed without a merge." },
} as const;
export type OmbEventType = keyof typeof OMB_EVENT_TYPES;

export const TYPE_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;

/** The subject kind that each domain needs. A new domain adds its subject kind here. */
export const DOMAIN_SUBJECT: Record<string, string> = { pr: "pr" };

export const OMB_EVENT_SCHEMA: Record<string, unknown> = schema;

export function payloadSchemaOf(type: string): Record<string, unknown> | null {
  const payloads = schema.$defs.payloads as Record<string, Record<string, unknown>>;
  return Object.hasOwn(payloads, type) ? payloads[type] : null;
}
