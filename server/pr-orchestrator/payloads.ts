import { ACTION_REGISTRY } from "./actions.ts";
import { payloadOf } from "./projection.ts";
import { configValue } from "./policy.ts";
import { ciStatus, readiness } from "./readiness.ts";
import {
  ASK_KINDS, MESSAGE_UNTRUSTED_VARS, MESSAGE_VARS, NOTICE_KINDS, TEMPLATE_IDS,
  type ActionType, type AskKind, type CommandAction, type CommandPayload, type JsonValue, type LedgerEntry, type NoticeKind,
  type PrRecord, type RepoConfig, type StepContext, type SubjectKey, type TemplateId, type TriggerName,
} from "./types.ts";

type Params = Record<string, JsonValue>;
type Vars = Record<string, string | number | boolean>;

const EVENT_JSON_BYTES = 16 * 1024;

export interface PayloadTrigger { name: TriggerName; entry: LedgerEntry; seq: number }

export interface BuildInput {
  action: CommandAction;
  params: Params;
  record: PrRecord | null;
  before: PrRecord | null;
  trigger: PayloadTrigger;
  ctx: StepContext;
  prKey: SubjectKey;
}
export type BuildResult = CommandPayload | { skip: string };
export type PayloadBuilder = (input: BuildInput) => BuildResult;

const skip = (reason: string): { skip: string } => ({ skip: reason });
const NEEDS_PR = "needs a PR subject";

function isConfigRef(value: unknown): value is { config: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as { config?: unknown }).config === "string";
}

export function resolveParams(params: Params, config: RepoConfig): Params {
  const resolved: Params = {};
  for (const [name, value] of Object.entries(params)) {
    resolved[name] = isConfigRef(value) ? (configValue(config, value.config) ?? null) : value;
  }
  return resolved;
}

function configPathOf(params: Params, name: string): string | null {
  const value = params[name];
  return isConfigRef(value) ? value.config : null;
}

export function placeholderValues(
  record: PrRecord | null, trigger: PayloadTrigger, ctx: StepContext, before: PrRecord | null = null,
): { vars: Vars; untrusted: Record<string, string> } {
  const event = trigger.entry.type === "event.received" ? trigger.entry.event : null;
  const vars: Vars = Object.fromEntries(MESSAGE_VARS.map(name => [name, ""]));
  const untrusted: Record<string, string> = Object.fromEntries(MESSAGE_UNTRUSTED_VARS.map(name => [name, ""]));
  vars.eventKind = event?.type ?? trigger.name;
  if (event?.type === "pr.ci.finished") vars.ciStatus = payloadOf(event, "pr.ci.finished").check.status;
  if (event?.type === "pr.review.finished") vars.reviewStatus = payloadOf(event, "pr.review.finished").review.status;
  if (event?.type === "pr.merged") vars.mergeSha = (event.data as { merge?: { commitSha?: string | null } }).merge?.commitSha ?? "";
  if (event) untrusted.eventJson = Buffer.from(JSON.stringify(event)).subarray(0, EVENT_JSON_BYTES).toString("utf8");
  if (record === null) {
    untrusted.title = event?.subject.kind === "pr" ? "" : (event?.subject as { label?: string } | undefined)?.label ?? "";
    return { vars, untrusted };
  }
  Object.assign(vars, {
    repo: record.repo, number: record.number, url: record.url ?? "", headSha: record.headSha ?? "", baseRef: record.baseRef ?? "",
    branch: record.branch ?? "", state: record.state,
    failedChecks: ciStatus(record, ctx).failing.map(check => check.name).join(", "),
  });
  untrusted.title = record.title ?? "";
  untrusted.answer = record.lastAnswer?.answer ?? "";
  untrusted.question = record.pendingDecision?.kind ?? before?.pendingDecision?.kind ?? "";
  return { vars, untrusted };
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;

export const PAYLOAD_BUILDERS: Readonly<Record<ActionType, PayloadBuilder>> = {
  TellOwner({ params, record, before, trigger, ctx }) {
    if (record === null) return skip(NEEDS_PR);
    const template = oneOf<TemplateId>(params.template, TEMPLATE_IDS);
    if (template === null) return skip(`unknown message template ${String(params.template)}`);
    const { vars, untrusted } = placeholderValues(record, trigger, ctx, before);
    return { type: "TellOwner", template, headSha: record.headSha, vars, untrusted };
  },

  AskPerson({ params, record, prKey, trigger, ctx }) {
    const kind = oneOf<AskKind>(params.kind, ASK_KINDS);
    if (kind === null) return skip(`unknown question kind ${String(params.kind)}`);
    return { type: "AskPerson", kind, decisionId: `${prKey}#${trigger.seq}`, gaps: record === null ? [] : readiness(record, ctx).gaps, gated: null };
  },

  Instruct({ params, record, before, trigger, ctx }) {
    const to = oneOf(params.to, ["owner", "new-agent"] as const);
    if (to === null) return skip(`unknown instruction target ${String(params.to)}`);
    if (to === "owner" && record === null) return skip(NEEDS_PR);
    if (typeof params.prompt !== "string" || params.prompt === "") return skip("the prompt is empty");
    const { vars, untrusted } = placeholderValues(record, trigger, ctx, before);
    return {
      type: "RunInstruction", to, headSha: record?.headSha ?? null, prompt: params.prompt, vars, untrusted,
      harness: typeof params.harness === "string" ? params.harness : null,
      model: typeof params.model === "string" ? params.model : null,
    };
  },

  RunWorkflow({ params, record, before, trigger, ctx }) {
    if (record === null) return skip(NEEDS_PR);
    const workflow = params.workflow;
    if (typeof workflow !== "string" || workflow === "") return skip("the workflow is empty");
    if (typeof params.message !== "string" || params.message === "") return skip("the workflow message is empty");
    const { vars, untrusted } = placeholderValues(record, trigger, ctx, before);
    return {
      type: "RunWorkflow", guard: ACTION_REGISTRY.RunWorkflow.guard!(params), workflow,
      connection: typeof params.connection === "string" ? params.connection : null,
      headSha: record.headSha, message: params.message, vars, untrusted,
    };
  },

  Merge({ record, ctx }) {
    if (record === null) return skip(NEEDS_PR);
    if (record.headSha === null) return skip("head unknown");
    return { type: "Merge", method: ctx.config.merge.method, expectedHeadSha: record.headSha, deleteBranch: ctx.config.merge.deleteBranch };
  },

  Notify({ params }) {
    const kind = oneOf<NoticeKind>(params.kind, NOTICE_KINDS);
    return kind === null ? skip(`unknown notice kind ${String(params.kind)}`) : { type: "Notify", kind };
  },

  RefreshDetails({ record }) {
    if (record === null) return skip(NEEDS_PR);
    return record.headSha === null ? skip("head unknown") : { type: "RefreshDetails", headSha: record.headSha };
  },
};

export function buildPayload(input: BuildInput): BuildResult {
  const builder = PAYLOAD_BUILDERS[input.action.do];
  const resolved = resolveParams(input.params, input.ctx.config);
  if (input.action.do === "RunWorkflow" && (typeof resolved.workflow !== "string" || resolved.workflow === "")) {
    const path = configPathOf(input.params, "workflow");
    return skip(path === null ? "the workflow is empty" : `config ${path} is empty`);
  }
  return builder({ ...input, params: resolved });
}
