import type { CiCheck, FailedJob, Forge, OmbEventV1, ReviewItem } from "./contract/omb-event.v1.ts";

/** The forge of a PR subject. */
export type Provider = Forge;

/** `${provider}:${repo in lower case}#${number}` */
export type PrKey = string;
/** A PR key, or `subject:<connector>:<kind>:<key>` for any other subject. */
export type SubjectKey = string;
export function prKey(provider: Provider, repo: string, number: number): PrKey {
  return `${provider}:${repo.toLowerCase()}#${number}`;
}

/** What an event is about. Kind "pr" carries pr and is the only kind the PR process manager reads. */
/** A conforming contract event as OMB stores it: the contract fields plus where it came in. */
export type OmbEvent = OmbEventV1 & {
  /** The connector instance id (from the URL or the subscription), not part of the contract. */
  connector: string;
  /** `${connector instance}:${id}`: the dedupe key. */
  key: string;
  subjectKey: SubjectKey;
  rawRef: { receivedSeq: number } | null;
};
export function subjectKeyOf(instance: string, event: Pick<OmbEventV1, "subject">): SubjectKey {
  const s = event.subject;
  return s.kind === "pr" && "forge" in s ? prKey(s.forge, s.repo, s.number) : `subject:${instance}:${s.kind}:${"id" in s ? s.id : ""}`;
}

export const PR_STATES = ["open", "ci_running", "ci_failed", "fixing", "reviewing", "needs_decision", "ready", "merging", "merged", "closed"] as const;
export type PrState = (typeof PR_STATES)[number];

/** Triggers of the core itself; the PR event kinds are the GitHub Event and GitLab Event types. */
export const CORE_TRIGGERS = ["owner.bound", "person.answered", "timer.fired", "command.issued", "command.finished", "run.finished"] as const;
export const PR_EVENT_TRIGGERS = ["pr.opened", "pr.pushed", "pr.ci.finished", "pr.review.finished", "pr.merged", "pr.closed", "pr.conflict.detected", "pr.comment.created"] as const;
export const TRIGGER_NAMES = [...PR_EVENT_TRIGGERS, ...CORE_TRIGGERS] as const;
/** A core trigger or an event type that a registered connector declares (checked against the registry by the config). */
export type TriggerName = string;

export const COMMAND_TYPES = ["TellOwner", "AskPerson", "Merge", "Notify", "RefreshDetails", "RunWorkflow", "RunInstruction"] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** Routine action types; each is an entry of ACTION_REGISTRY (actions.ts). A new action type is added here and there. */
export const ACTION_TYPES = ["TellOwner", "AskPerson", "Notify", "Merge", "RefreshDetails", "RunWorkflow", "Instruct"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Placeholders that owner messages and Instruct prompts may use; the untrusted ones are always fenced. */
export const MESSAGE_VARS = ["repo", "number", "url", "headSha", "baseRef", "branch", "state", "failedChecks", "mergeSha", "eventKind", "ciStatus", "reviewStatus"] as const;
export const MESSAGE_UNTRUSTED_VARS = ["title", "logTail", "answer", "question", "eventJson"] as const;

export const TEMPLATE_IDS = ["conflict", "decisionAnswered", "merged"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const ASK_KINDS = ["decision", "command_failed", "approve_action"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export const NOTICE_KINDS = ["merged", "ready_no_auto_merge", "review_failed"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const TIMER_KINDS = ["merge.window"] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

export const READINESS_GAPS = ["draft", "head_unknown", "checks_not_passed", "conflict", "review_not_passed", "forge_stale", "not_mergeable"] as const;
export type ReadinessGap = (typeof READINESS_GAPS)[number];

export type MergeMethod = "squash" | "merge" | "rebase";

/** Where a PR points, for ports and messages. */
export interface PrRef {
  key: PrKey; provider: Provider; repo: string; number: number;
  url: string | null; headSha: string | null; branch: string | null; baseRef: string | null;
}

/** The agent session that owns a PR: the root of its agent chain. */
export interface Owner {
  runtime: string; hostId: string; agentId: string;
  workspaceId: string | null; projectId: string | null; harness: string | null; model: string | null;
  /** The folder the session runs in; a new agent for the same PR starts there. Older ledger rows lack it. */
  cwd?: string | null;
  boundBy: "provenance" | "claim" | "backfill" | "successor";
  boundAt: number;
}

/** The words a forge adapter uses for what blocks a merge. "conflict" sets the record's conflict flag. */
export const FORGE_BLOCKERS = ["conflict", "approvals", "protected_branch", "behind", "checks", "discussions", "draft", "not_open", "blocked"] as const;
export type ForgeBlocker = (typeof FORGE_BLOCKERS)[number];

/** Not a finish: the bus runs the command again after retryAfterSeconds. Used only while a forge computes a fact or a port cannot be reached. */
export interface CommandWait { outcome: "waiting"; reason: string; retryAfterSeconds: number }

export interface ForgeDetails {
  headSha: string;
  /** null: the forge has not computed it yet. */
  mergeable: boolean | null;
  blockers: ForgeBlocker[];
  /** Check keys `${source}/${name}`; null when the forge does not say. */
  requiredChecks: string[] | null;
  /** Job names or check keys that also fail on the base branch head. */
  baseFailing: string[];
  failedJobs: FailedJob[];
}

export interface CheckFact {
  key: string; source: string; name: string; scope: CiCheck["scope"]; status: CiCheck["status"];
  url: string; runId: string | null; failedJobs: FailedJob[]; headSha: string; at: number;
}
export interface ReviewFact {
  status: "success" | "needs-person" | "failed"; reviewedSha: string; rounds: number; maxRounds: number;
  items: ReviewItem[]; commentId: string; commentUrl: string; at: number;
}
export interface PendingDecision { decisionId: string; kind: AskKind; askedAt: number; commandId: string; gatedCommandId: string | null }

/** The projected state of one PR; rebuilt from its ledger by fold. */
export interface PrRecord {
  key: PrKey; provider: Provider; repo: string; number: number;
  url: string | null; title: string | null; branch: string | null; baseRef: string | null; author: string | null;
  headSha: string | null; headSetAt: number | null; draft: boolean;
  state: PrState; stateSince: number;
  owner: Owner | null;
  /** Latest result per check key, for the current head only. */
  checks: Record<string, CheckFact>;
  review: ReviewFact | null;
  forge: (ForgeDetails & { at: number }) | null;
  conflict: boolean;
  /** The single-active-run guard: one entry per active target (e.g. "workflow:ci-fix"); cleared by run.finished or a failed start. */
  activeRuns: Record<string, ActiveRun>;
  pendingDecision: PendingDecision | null;
  lastAnswer: { decisionId: string; answer: string; at: number; kind: AskKind | null } | null;
  createdAt: number; updatedAt: number; lastSeq: number;
}

export interface ActiveRun { commandId: string; since: number; status: "awaiting_approval" | "starting" | "running"; runRef: string | null }

export type CommandPayload =
  /** The owner is resolved when the command runs (the ledger's owner.bound, then the resolver chain); not found → skipped. */
  | { type: "TellOwner"; template: TemplateId; headSha: string | null; vars: Record<string, string | number | boolean>; untrusted: Record<string, string> }
  /** gated: the held command of an ask-first action (kind approve_action). */
  | { type: "AskPerson"; kind: AskKind; decisionId: string; gaps: ReadinessGap[]; gated: { commandId: string; command: CommandType; summary: string } | null;
      /** The command that failed, for a command_failed card. Rows written before this field existed read as null. */
      about?: { command: CommandType; reason: string } | null }
  | { type: "Merge"; method: MergeMethod; expectedHeadSha: string; deleteBranch: boolean }
  | { type: "Notify"; kind: NoticeKind }
  | { type: "RefreshDetails"; headSha: string }
  /** A guarded long-running action; guard is the target that the single-active-run guard keys on. */
  | { type: "RunWorkflow"; guard: string; workflow: string; connection: string | null; headSha: string | null; message: string; vars: Record<string, string | number | boolean>; untrusted: Record<string, string> }
  | { type: "RunInstruction"; to: "owner" | "new-agent"; headSha: string | null; prompt: string; vars: Record<string, string | number | boolean>; untrusted: Record<string, string>; harness: string | null; model: string | null };

export type CommandDetail = { forge: ForgeDetails } | { merged: boolean; sha: string | null } | { cardId: string } | { runRef: string };
export type CommandResult =
  | { outcome: "succeeded"; detail?: CommandDetail }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string; retryable: boolean };

/** A row of the commands table. */
export interface CommandRecord {
  id: string; subjectKey: SubjectKey; type: CommandType; routineId: string; idemKey: string;
  status: "awaiting_approval" | "pending" | "running" | "done"; outcome: CommandResult["outcome"] | null;
  /** The decision id of the ask-first card while status is awaiting_approval. */
  approvalId: string | null;
  attempts: number; nextAt: number; createdAt: number; updatedAt: number;
  payload: CommandPayload; result: CommandResult | null; lastError: string | null;
}
export interface TimerRecord {
  id: string; subjectKey: SubjectKey; kind: TimerKind; idemKey: string; dueAt: number; createdAt: number;
  state: "armed" | "fired" | "cancelled"; payload: { routineId: string };
}

/** Entries that come from outside a step. */
export type InputEntry =
  /** Any connector's conforming event; for a "pr" subject, fold reads event.data by event.type (PrPayloadByType). */
  | { type: "event.received"; event: OmbEvent; receivedSeq: number }
  /** pr lets a binding create the record before the hub's opened event arrives. */
  | { type: "owner.bound"; owner: Owner; pr: { provider: Provider; repo: string; number: number; url: string | null } }
  /** A guarded run ended (sent by a workflow runtime adapter); clears activeRuns[target]. */
  | { type: "run.finished"; target: string; runRef: string; outcome: "completed" | "failed" | "cancelled" }
  | { type: "person.answered"; decisionId: string; answer: string }
  | { type: "timer.fired"; timerId: string; kind: TimerKind }
  /** payload is the issued payload, so fold can apply the effects of a command that succeeded. */
  | { type: "command.finished"; commandId: string; command: CommandType; payload: CommandPayload; result: CommandResult };
/** Entries that a step derived. */
export type DecisionEntry =
  | { type: "state.changed"; from: PrState | null; to: PrState; trigger: TriggerName }
  | { type: "transition.refused"; from: PrState | null; to: PrState; trigger: TriggerName | "loop_cap" }
  | { type: "command.gated"; commandId: string; command: CommandType; routineId: string; payload: CommandPayload; decisionId: string }
  | { type: "command.issued"; commandId: string; command: CommandType; routineId: string; payload: CommandPayload }
  | { type: "timer.scheduled"; timerId: string; kind: TimerKind; dueAt: number; routineId: string }
  | { type: "timer.cancelled"; timerId: string; kind: TimerKind; routineId: string }
  /** One run of a routine: it matched, and at least one action was not a duplicate. */
  | { type: "routine.matched"; routineId: string; trigger: TriggerName; triggerSeq: number;
      actions: Array<{ action: string; idemKey: string | null; result: "issued" | "gated" | "scheduled" | "cancelled" | "skipped"; commandId?: string; reason?: string }> };
export type LedgerEntry = InputEntry | DecisionEntry;

/** One stored ledger row. */
export interface LedgerRow { seq: number; subjectKey: SubjectKey; at: number; configVersion: string; causationSeq: number | null; entry: LedgerEntry }

/** Input to the process manager (the ledger adds seq and time). */
export type CoreInput = InputEntry;

export const FACT_NAMES = ["state", "previousState", "draft", "conflict", "owner.known", "pendingDecision", "run.activeCount",
  "trigger.isHead", "trigger.ci.status", "trigger.review.status", "trigger.timer.kind", "trigger.command.type", "trigger.command.outcome",
  "trigger.command.reason", "trigger.run.target", "trigger.run.outcome", "trigger.answer.kind", "ci.failingCount",
  "review.staleForHead", "readiness.ready", "readiness.onlyForgeMissing",
  "merge.quietNow", "merge.minutesToWindow",
  "event.branch", "event.baseRef", "event.author", "event.check.source", "event.check.name",
  "event.connector", "event.type", "event.subject.kind"] as const;
export type FactName = (typeof FACT_NAMES)[number];
export type FactValue = string | number | boolean | null;
export type FactMap = Record<FactName, FactValue>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ValueRef = { config: string } | { fact: FactName };
export interface Predicate {
  /** `event.data.<path>` reads any field of the trigger event's data. */
  fact: FactName | `config.${string}` | `event.data.${string}`;
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "truthy" | "falsy";
  value?: JsonValue | ValueRef;
}
/** A registered action: params are checked by its ACTION_REGISTRY entry; askFirst holds it for the person's approval. */
export type CommandAction = { do: ActionType; params?: Record<string, JsonValue>; askFirst?: boolean };
export type RoutineAction =
  | CommandAction
  | { schedule: TimerKind; afterMinutes: number | ValueRef }
  | { cancel: TimerKind | "all" };
/** A routine the person configures: a trigger, its filters and facts, and the actions to take. */
export interface Routine {
  id: string; name: string; active: boolean; description?: string;
  when: { connectors?: string[]; providers?: Provider[]; repos?: string[]; on: Array<TriggerName | "*">; all?: Predicate[] };
  then: RoutineAction[];
  once: "per-trigger" | "per-head" | "per-pr";
  onceGroup?: string;
}
/** What policy.evaluate returns: one action of one matching routine; idemKey null only for cancel. */
export interface Intent { routineId: string; actionIndex: number; idemKey: string | null; action: RoutineAction }
export const MAX_ROUTINES = 50;
export const ROUTINE_HISTORY_SHOWN = 20;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | null : T[K] };

/** The config document in DATA_DIR/pr-orchestrator.json, after defaults. */
/** One connector instance in the config; settings are checked by its definition's settingsSchema. */
export interface ConnectorInstanceConfig { use: string; enabled: boolean; secretName?: string; settings: Record<string, JsonValue> }

/** The adapter switches. The secret fields hold Vault names, never values. */
export interface AdapterSwitches {
  forge: {
    github: { enabled: boolean; auth: "app" | "token"; apiUrl: string; appIdSecret: string; privateKeySecret: string; tokenSecret: string };
    gitlab: { enabled: boolean; baseUrl: string; tokenSecret: string };
  };
  notifier: { enabled: boolean };
  runtime: { enabled: boolean; bindOwners: boolean };
}

export interface OrchestratorConfig {
  enabled: boolean;
  connectors: Record<string, ConnectorInstanceConfig>;
  readiness: {
    requiredChecks: string[]; compareBase: boolean; requireReview: boolean; requireReviewedHead: boolean; requireMergeable: boolean;
  };
  merge: { auto: boolean; method: MergeMethod; deleteBranch: boolean; quietHours: { start: string; end: string; timeZone: string } | null };
  /** Workflows that routines run; ciFix.workflow empty means run-ci-fix-workflow does nothing. */
  workflows: { ciFix: { workflow: string; connection: string | null; message: string } };
  escalation: { decision: boolean; notifier: "inbox"; digestMinutes: number; decisionChoices: string[] };
  /** Where a new agent runs when the PR has no live owner, and with which harness and model. */
  agents: { newAgent: { cwd: string | null; harness: string | null; model: string | null } };
  /** Each adapter has its own switch; the config is read on every call, so a switch takes effect on the next command. */
  adapters: AdapterSwitches;
  /** maxWaits bounds the waits of a command whose forge has not computed a fact yet, or whose port cannot be reached. */
  commands: { maxAttempts: number; maxWaits: number; backoffSeconds: { initial: number; max: number }; concurrency: number };
  messages: Record<TemplateId, string>;
  retention: { endedPrDays: number; receivedEventDays: number };
  /** The default routines first (custom ones with the same id replace them), then new custom ones; deactivate turns defaults off. */
  routines: { useDefaults: boolean; custom: Routine[]; deactivate: string[] };
  overrides: ConfigOverride[];
}
export type RepoTunable = Omit<OrchestratorConfig, "enabled" | "connectors" | "adapters" | "commands" | "retention" | "routines" | "overrides">;
/** Tunables per repo; routines carry their own provider and repo filters. */
export interface ConfigOverride {
  match: { providers?: Provider[]; repos?: string[] };
  set?: DeepPartial<RepoTunable>;
}
/** The config for one repo: overrides applied, routines resolved (inactive ones kept with active false). */
export type RepoConfig = Omit<OrchestratorConfig, "routines" | "overrides"> & { routines: Routine[] };

/** What a pure step function needs besides the record. */
export interface StepContext {
  now: number;
  config: RepoConfig;
  configVersion: string;
}

/** One conforming event that the sender may count as taken. Non-conforming events never reach the core. */
export interface AcceptItem { event: OmbEvent; raw: string }

/** What the intake door hands to the core. */
export interface IntakeSink {
  /** Stores the items durably (a repeated id is kept once) and returns at once; throws when the store cannot write. */
  accept(items: AcceptItem[], now: number): { stored: number; duplicates: number };
}
