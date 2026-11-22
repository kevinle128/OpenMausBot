import type { z } from "zod";
import type { FailedJob } from "./contract/omb-event.v1.ts";
import type { AskKind, ForgeDetails, JsonValue, MergeMethod, NoticeKind, OmbEvent, Owner, PrRef } from "./types.ts";

export type { ForgeDetails };

/** Thrown by a stub adapter: the port has no real adapter yet. */
export class NotInstalledError extends Error {
  constructor(port: string, method: string) {
    super(`${port}.${method} is not installed`);
    this.name = "NotInstalledError";
  }
}

/** Calls to a forge (GitHub App or GitLab token from the OMB Vault). Every argument that came from a native payload is untrusted data. */
export interface ForgePort {
  readonly provider: "github" | "gitlab";
  details(pr: PrRef): Promise<ForgeDetails>;
  ciLog(pr: PrRef, job: FailedJob, opts: { tailLines: number }): Promise<string>;
  reviewItems(pr: PrRef, commentId: string): Promise<ReviewNeedsItem[]>;
  merge(pr: PrRef, opts: { method: MergeMethod; expectedHeadSha: string; deleteBranch: boolean }): Promise<{ merged: boolean; sha?: string; reason?: string }>;
  comment(pr: PrRef, text: string): Promise<{ url?: string }>;
}

export interface ReviewNeedsItem { file?: string; problem: string; choices: string[]; proposal?: string; isDecision: boolean }

/** Turns a raw check or comment into a CI or review signal; registered by source. */
export interface SignalInterpreter {
  /** "github-actions", "gitlab-ci", "ocr" and so on. */
  readonly source: string;
  interpret(event: OmbEvent, forge: ForgePort): Promise<{ needsPerson: ReviewNeedsItem[]; forOwner: ReviewNeedsItem[] } | null>;
}

/** A place where agent sessions run (Paseo first). */
export interface AgentRuntimePort {
  readonly runtime: string;
  watchCreations(cb: (created: { prUrl: string; owner: Owner; at: number }) => void): () => void;
  send(owner: Owner, message: string, opts: { afterTurn: boolean }): Promise<"delivered" | "queued" | "gone">;
  isAlive(owner: Owner): Promise<boolean>;
  spawn(req: { projectId: string; harness: string; model: string; branch: string; cwdHint?: string; brief: string }): Promise<Owner>;
  label(owner: Owner, key: string, value: string): Promise<void>;
}

/** Runs a named workflow for a PR (Archon first). */
export interface WorkflowRuntimePort {
  start(req: { pr: PrRef; workflow: string; message: string; connection: string | null }): Promise<{ runRef: string }>;
  cancel(runRef: string): Promise<void>;
  /** The adapter reports each run's end; the core turns it into a run.finished input. */
  watch(cb: (done: { runRef: string; outcome: "completed" | "failed" | "cancelled"; at: number }) => void): () => void;
}

/** One link of the owner resolution chain; "next" passes to the following link. Used best-effort by TellOwner. */
export interface OwnerResolver {
  readonly name: string;
  resolve(pr: PrRef): Promise<Owner | "next">;
}

/** Where the person is told or asked (OMB Inbox first). */
export interface NotifierPort {
  card(kind: AskKind, payload: { pr: PrRef; title: string; body: string; decisionId: string }, answers?: Array<{ id: string; label: string }>): Promise<{ cardId: string }>;
  notice(kind: NoticeKind, text: string, pr?: PrRef): Promise<void>;
}

export interface Clock { now(): number }

export interface InboundRequest { method: string; headers: Record<string, string | undefined> }

export interface InboundContext<S> {
  /** The connector instance id, from the URL. */
  instance: string;
  settings: S;
  /** The instance's Vault secret, or null when it has none. */
  key: Buffer | null;
  now: number;
}

export type Verdict = { ok: true } | { ok: false; status: number; reason: string; signatureFailure?: boolean };

export interface SubscriptionContext<S> {
  instance: string;
  settings: S;
  key: Buffer | null;
  signal: AbortSignal;
  now(): number;
  /** Takes events that the adapter has already conformed to the contract. The core validates them like inbound items, and rejects and logs the ones that do not conform. */
  emit(events: unknown[]): void;
  cursor(): string | null;
  saveCursor(cursor: string): void;
  report(health: { ok: boolean; detail?: string }): void;
}

/**
 * A connector is a declaration plus a delivery adapter. It carries transport methods only: every event must
 * already conform to the OMB event contract, and the intake checks it. Every method that takes a native payload
 * treats it as untrusted data.
 */
export interface ConnectorDefinition<S = unknown> {
  /** For example "github-event"; also the default instance id and the expected source.connector. */
  id: string;
  title: string;
  description: string;
  icon: { glyph: string } | { image: string };
  /** The contract event types this connector emits; each must exist in CONTRACT_EVENT_TYPES. */
  emits: string[];
  /** Extra subject checks as data, for example { forge: "github" }: every event's subject must have these values. */
  subjectRule?: Record<string, string>;
  delivery: "inbound-http" | "subscription" | "poll";
  /** Transport settings only, checked inside the config document. */
  settingsSchema: z.ZodType<S>;
  /** A Vault secret name; the value is never shown. */
  secret: { required: boolean; defaultName: string };
  defaultInstance?: { enabled: boolean; settings: S };
  /** Transport and auth only; served at POST /events/<instance id>. */
  inbound?: {
    precheck?(req: InboundRequest, ctx: InboundContext<S>): Verdict;
    verify(req: InboundRequest & { body: Buffer }, ctx: InboundContext<S>): Verdict;
    parse(body: Buffer, ctx: InboundContext<S>): { ok: true; items: unknown[] } | { ok: false; status: number; reason: string };
    respond(result: { accepted: string[]; rejected: Array<{ id: string | null; reason: string }> }): { status: number; body: JsonValue };
  };
  /** Emits contract events through ctx.emit(events); the cursor is kept through ctx.saveCursor. */
  subscribe?(ctx: SubscriptionContext<S>): Promise<void>;
}
