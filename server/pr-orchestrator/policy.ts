import { anyGlob } from "./glob.ts";
import type {
  CommandAction, FactMap, FactName, Intent, JsonValue, OmbEvent, Predicate, Provider, RepoConfig, Routine, RoutineAction,
  SubjectKey, TriggerName, ValueRef,
} from "./types.ts";
import { TRIGGER_NAMES } from "./types.ts";

function readPath(root: unknown, path: string): JsonValue | undefined {
  if (path === "") return undefined;
  let node: unknown = root;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node as JsonValue | undefined;
}

/** Reads a dotted path such as `workflows.ciFix.workflow`; a missing path gives undefined. */
export function configValue(config: RepoConfig, path: string): JsonValue | undefined {
  return readPath(config, path);
}

function isValueRef(value: unknown): value is ValueRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0] as string;
  return (key === "config" || key === "fact") && typeof (value as Record<string, unknown>)[key] === "string";
}

/** Resolves a `{ config }` or `{ fact }` reference; any other value is returned as it is. */
export function resolveValue(value: JsonValue | ValueRef | undefined, facts: FactMap, config: RepoConfig): JsonValue | undefined {
  if (!isValueRef(value)) return value as JsonValue | undefined;
  if ("config" in value) return configValue(config, value.config);
  return factValue(facts, value.fact);
}

function factValue(facts: FactMap, name: string): JsonValue | undefined {
  return Object.hasOwn(facts, name) ? (facts[name as FactName] as JsonValue) : undefined;
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function leftSide(p: Predicate, facts: FactMap, config: RepoConfig, event: OmbEvent | null): JsonValue | undefined {
  if (p.fact.startsWith("config.")) return configValue(config, p.fact.slice(7));
  if (p.fact.startsWith("event.data.")) return event ? readPath(event.data, p.fact.slice(11)) : undefined;
  return factValue(facts, p.fact);
}

/** Never throws. A missing left side makes every comparison false; only `falsy` holds for it. */
export function predicateHolds(p: Predicate, facts: FactMap, config: RepoConfig, event: OmbEvent | null = null): boolean {
  try {
    const left = leftSide(p, facts, config, event);
    if (p.op === "truthy") return Boolean(left);
    if (p.op === "falsy") return !left;
    if (left === undefined) return false;
    const right = resolveValue(p.value, facts, config);
    switch (p.op) {
      case "eq": return isScalar(left) && isScalar(right) && left === right;
      case "ne": return isScalar(left) && isScalar(right) && left !== right;
      case "in": return Array.isArray(right) && right.includes(left);
      case "lt": case "lte": case "gt": case "gte": {
        if (typeof left !== "number" || typeof right !== "number" || !Number.isFinite(left) || !Number.isFinite(right)) return false;
        if (p.op === "lt") return left < right;
        if (p.op === "lte") return left <= right;
        if (p.op === "gt") return left > right;
        return left >= right;
      }
      default: return false;
    }
  } catch {
    return false;
  }
}

export interface RoutineMatchInput {
  trigger: TriggerName;
  connector: string | null;
  provider: Provider | null;
  repo: string | null;
  event: OmbEvent | null;
  facts: FactMap;
  config: RepoConfig;
}

export function routineMatches(r: Routine, input: RoutineMatchInput): boolean {
  if (!r.active) return false;
  const { when } = r;
  if (!when.on.includes(input.trigger) && !when.on.includes("*")) return false;
  if (when.connectors?.length && (input.connector === null || !when.connectors.includes(input.connector))) return false;
  if (when.providers?.length && (input.provider === null || !when.providers.includes(input.provider))) return false;
  if (when.repos?.length && (input.repo === null || !anyGlob(when.repos, input.repo))) return false;
  return (when.all ?? []).every(p => predicateHolds(p, input.facts, input.config, input.event));
}

export interface EvaluateInput extends RoutineMatchInput {
  routines: readonly Routine[];
  triggerSeq: number;
  subjectKey: SubjectKey;
  headSha: string | null;
}
export interface EvaluateResult {
  intents: Intent[];
  matched: string[];
  skipped: Array<{ routineId: string; reason: string }>;
}

function scopeOf(r: Routine, input: EvaluateInput): string {
  if (r.once === "per-trigger") return String(input.triggerSeq);
  if (r.once === "per-head") return input.headSha ?? "nohead";
  return "pr";
}

/** Pure: it does not know which keys were used before; the store's unique idempotency key dedupes. */
export function evaluate(input: EvaluateInput): EvaluateResult {
  const intents: Intent[] = [];
  const matched: string[] = [];
  const skipped: Array<{ routineId: string; reason: string }> = [];
  for (const r of input.routines) {
    if (!routineMatches(r, input)) continue;
    matched.push(r.id);
    const scope = scopeOf(r, input);
    r.then.forEach((action, actionIndex) => {
      if ("schedule" in action) {
        const minutes = resolveValue(action.afterMinutes, input.facts, input.config);
        if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
          skipped.push({ routineId: r.id, reason: "the delay of the schedule action is not a number above zero" });
          return;
        }
        action = { schedule: action.schedule, afterMinutes: minutes };
      }
      const idemKey = "cancel" in action ? null : `${input.subjectKey}|${r.onceGroup ?? r.id}|${scope}|${actionIndex}`;
      intents.push({ routineId: r.id, actionIndex, idemKey, action });
    });
  }
  return { intents, matched, skipped };
}

/** The editor's phrase for each trigger. */
export const TRIGGER_PHRASES: Record<(typeof TRIGGER_NAMES)[number], string> = {
  "pr.opened": "a PR is opened",
  "pr.pushed": "a commit is pushed to a PR",
  "pr.ci.finished": "CI finishes",
  "pr.review.finished": "a review finishes",
  "pr.merged": "a PR is merged",
  "pr.closed": "a PR is closed",
  "pr.conflict.detected": "a merge conflict is detected",
  "pr.comment.created": "a comment is posted on a PR",
  "owner.bound": "an owner is bound to a PR",
  "person.answered": "the person answers a question",
  "timer.fired": "a timer fires",
  "command.issued": "a command is issued",
  "command.finished": "a command finishes",
  "run.finished": "a workflow run finished",
};

const OP_WORDS: Record<Predicate["op"], string> = {
  eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=", in: "in", truthy: "is set", falsy: "is not set",
};

function isRef(value: unknown): value is ValueRef {
  return isValueRef(value);
}

function showValue(value: JsonValue | ValueRef | undefined): string {
  if (isRef(value)) return "config" in value ? `config ${value.config}` : `fact ${value.fact}`;
  if (value === undefined) return "nothing";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function describePredicate(p: Predicate): string {
  if (p.op === "truthy" || p.op === "falsy") return `${p.fact} ${OP_WORDS[p.op]}`;
  return `${p.fact} ${OP_WORDS[p.op]} ${showValue(p.value)}`;
}

function describeStep(a: RoutineAction, describeAction: (a: CommandAction) => string): string {
  if ("schedule" in a) return `start the ${a.schedule} timer after ${showValue(a.afterMinutes)} minutes`;
  if ("cancel" in a) return a.cancel === "all" ? "cancel all timers" : `cancel the ${a.cancel} timer`;
  return `${describeAction(a)}${a.askFirst ? " (ask first)" : ""}`;
}

/** The "when to run" sentence of the editor. */
export function describeRoutine(
  r: Routine,
  describeAction: (a: CommandAction) => string,
  describeEventType: (connector: string | null, type: string) => string | null,
): string {
  const { when } = r;
  const connector = when.connectors?.length === 1 ? (when.connectors[0] as string) : null;
  const triggers = when.on.map(type => {
    if (type === "*") return "anything happens";
    const phrase = describeEventType(connector, type) ?? (TRIGGER_PHRASES as Record<string, string>)[type] ?? type;
    return phrase === type ? type : `${phrase} (${type})`;
  });
  const parts = [`When ${triggers.length ? triggers.join(" or ") : "nothing is chosen"}`];
  if (when.connectors?.length) parts.push(`from ${when.connectors.join(" or ")}`);
  if (when.providers?.length) parts.push(`on ${when.providers.join(" or ")}`);
  if (when.repos?.length) parts.push(`repos ${when.repos.join(", ")}`);
  const conditions = (when.all ?? []).map(describePredicate);
  if (conditions.length) parts.push(`if ${conditions.join(" and ")}`);
  const steps = r.then.map(a => describeStep(a, describeAction));
  return `${parts.join(", ")}: ${steps.length ? steps.join("; ") : "do nothing"}.`;
}
