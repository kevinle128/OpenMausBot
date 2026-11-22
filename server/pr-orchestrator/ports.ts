import type { z } from "zod";
import type { FailedJob } from "./contract/omb-event.v1.ts";
import type { AskKind, ForgeDetails, JsonValue, MergeMethod, NoticeKind, OmbEvent, Owner, PrRef, Provider, SubjectKey } from "./types.ts";

export type { ForgeDetails };

/** Thrown by a stub adapter: the port has no real adapter yet. */
export class NotInstalledError extends Error {
  constructor(port: string, method: string) {
    super(`${port}.${method} is not installed`);
    this.name = "NotInstalledError";
  }
}

/** The port's adapter cannot be reached now: the Paseo daemon is down, or the switch is on but nothing is attached yet. The command waits. */
export class PortUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortUnavailableError";
  }
}

/** The forge has not computed a fact yet (mergeability, a required check still pending); the command waits. */
export class ForgeNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeNotReadyError";
  }
}

/** A refusal that a retry cannot fix: credentials missing from the Vault, the App not installed, 401, 403 or 404. */
export class ForgeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeRefusedError";
  }
}

/** Calls to a forge (GitHub App or GitLab token from the OMB Vault). Every argument that came from a native payload is untrusted data. */
export interface ForgePort {
  readonly provider: "github" | "gitlab";
  details(pr: PrRef): Promise<ForgeDetails>;
  ciLog(pr: PrRef, job: FailedJob, opts: { tailLines: number }): Promise<string>;
  reviewItems(pr: PrRef, commentId: string): Promise<ReviewNeedsItem[]>;
  /** merged: false with headMoved true means the PR head is no longer expectedHeadSha. An already merged PR gives merged: true. */
  merge(pr: PrRef, opts: { method: MergeMethod; expectedHeadSha: string; deleteBranch: boolean }):
    Promise<{ merged: true; sha: string | null } | { merged: false; headMoved: boolean; reason: string }>;
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
  /** Reports each PR that an agent session opened; the core binds the PR to that session's owner. Returns the unsubscribe function. */
  watchCreations(cb: (created: { pr: { provider: Provider; repo: string; number: number; url: string }; owner: Owner; at: number }) => void): () => void;
  /** Sends the message at once, the way the Paseo app sends a typed message; a running turn gets it as the app's default (steer) gives it.
   *  "delivered": the runtime took it. "gone": closed, archived or unknown. The message id makes a repeated send safe. */
  send(owner: Owner, message: string, opts: { messageId: string }): Promise<"delivered" | "gone">;
  isAlive(owner: Owner): Promise<boolean>;
  /** Idempotent by requestId: a second call with the same id returns the agent that the first one created. */
  spawn(req: { requestId: string; cwd: string; workspaceId: string | null; harness: string; model: string | null; brief: string; labels: Record<string, string> }): Promise<Owner>;
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

/** What a card or a notice is about: a PR, or another subject that routines act on. */
export interface NoticeSubject { key: SubjectKey; pr: PrRef | null; label: string }

/** Where the person is told or asked (the Inbox first). */
export interface NotifierPort {
  /** Opens one card per decisionId; a second call with the same decisionId returns the open card. */
  card(kind: AskKind, payload: { subject: NoticeSubject; title: string; body: string; decisionId: string }, answers: Array<{ id: string; label: string }>): Promise<{ cardId: string }>;
  notice(kind: NoticeKind, text: string, subject: NoticeSubject): Promise<void>;
  /** Takes over a card that an earlier run opened; false when the card is gone, answered or dismissed. */
  adopt?(cardId: string, card: { kind: AskKind; decisionId: string; subject: NoticeSubject; answers: Array<{ id: string; label: string }> }): boolean;
  /** Closes this notifier's open cards whose decision is no longer open, and dismisses stale cards in its own conversation. */
  reconcile?(openDecisionIds: ReadonlySet<string>): void;
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
