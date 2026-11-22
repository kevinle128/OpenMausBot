import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseJson, schemaIssue } from "../schema.ts";
import { settledFileCache } from "../settled-file.ts";
import { checkAction, templateText } from "./actions.ts";
import { DEFAULT_ROUTINES } from "./default-routines.ts";
import { anyGlob } from "./glob.ts";
import { DEFAULT_MESSAGES } from "./messages.ts";
import type { ConnectorDefinition } from "./ports.ts";
import {
  CORE_TRIGGERS, FACT_NAMES, MAX_ROUTINES, TIMER_KINDS, ACTION_TYPES,
  type JsonValue, type OrchestratorConfig, type Provider, type RepoConfig, type RepoTunable, type Routine,
} from "./types.ts";

const PROVIDERS = ["github", "gitlab"] as const satisfies readonly Provider[];
const JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

const kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be kebab-case");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM");
const count = z.number().int().positive();
const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const valueRef = z.union([z.strictObject({ config: z.string().min(1) }), z.strictObject({ fact: z.enum(FACT_NAMES) })]);
const predicateSchema = z.strictObject({
  fact: z.union([z.enum(FACT_NAMES), z.templateLiteral(["config.", z.string()]), z.templateLiteral(["event.data.", z.string()])]),
  op: z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "in", "truthy", "falsy"]),
  value: z.union([valueRef, z.json()]).optional(),
});
const routineActionSchema = z.union([
  z.strictObject({ do: z.enum(ACTION_TYPES), params: z.record(z.string(), z.json()).optional(), askFirst: z.boolean().optional() }),
  z.strictObject({ schedule: z.enum(TIMER_KINDS), afterMinutes: z.union([count, valueRef]) }),
  z.strictObject({ cancel: z.enum([...TIMER_KINDS, "all"]) }),
]);
const routineSchema = z.strictObject({
  id: kebab,
  name: z.string().trim().min(1),
  active: z.boolean().default(true),
  description: z.string().optional(),
  when: z.strictObject({
    connectors: z.array(z.string().min(1)).optional(),
    providers: z.array(z.enum(PROVIDERS)).optional(),
    repos: z.array(z.string().min(1)).optional(),
    on: z.array(z.string().min(1)).min(1),
    all: z.array(predicateSchema).optional(),
  }),
  // oxlint-disable-next-line unicorn/no-thenable -- a routine's action list is named "then" in the config document
  then: z.array(routineActionSchema).min(1),
  once: z.enum(["per-trigger", "per-head", "per-pr"]),
  onceGroup: z.string().min(1).optional(),
});

const instanceSchema = z.strictObject({
  use: z.string().min(1),
  enabled: z.boolean().default(false),
  secretName: z.string().min(1).optional(),
  settings: z.record(z.string(), z.json()).default({}),
});

const message = templateText(8000);
const readinessFields = { requiredChecks: z.array(z.string().min(1)), compareBase: z.boolean(), requireReview: z.boolean(), requireReviewedHead: z.boolean(), requireMergeable: z.boolean() };
const quietHours = z.strictObject({ start: clock, end: clock, timeZone: z.string().refine(validZone, "is not a time zone") });
const mergeFields = { auto: z.boolean(), method: z.enum(["squash", "merge", "rebase"]), deleteBranch: z.boolean(), quietHours: quietHours.nullable() };
const ciFixFields = { workflow: z.string().max(200), connection: z.string().min(1).nullable(), message };
const escalationFields = { decision: z.boolean(), notifier: z.literal("inbox"), digestMinutes: z.number().int().nonnegative() };
const messageFields = { conflict: message, decisionAnswered: message, merged: message };

const readinessSection = z.strictObject({
  requiredChecks: readinessFields.requiredChecks.default([]), compareBase: readinessFields.compareBase.default(true),
  requireReview: readinessFields.requireReview.default(true), requireReviewedHead: readinessFields.requireReviewedHead.default(true),
  requireMergeable: readinessFields.requireMergeable.default(true),
}).prefault({});
const mergeSection = z.strictObject({
  auto: mergeFields.auto.default(true), method: mergeFields.method.default("squash"),
  deleteBranch: mergeFields.deleteBranch.default(true), quietHours: mergeFields.quietHours.default(null),
}).prefault({});
const workflowsSection = z.strictObject({
  ciFix: z.strictObject({
    workflow: ciFixFields.workflow.default(""), connection: ciFixFields.connection.default(null),
    message: ciFixFields.message.default("CI failed on {{repo}}#{{number}} at {{headSha}}: {{failedChecks}}. {{url}}"),
  }).prefault({}),
}).prefault({});
const escalationSection = z.strictObject({
  decision: escalationFields.decision.default(true), notifier: escalationFields.notifier.default("inbox"), digestMinutes: escalationFields.digestMinutes.default(0),
}).prefault({});
const commandsSection = z.strictObject({
  maxAttempts: count.default(6),
  backoffSeconds: z.strictObject({ initial: count.default(30), max: count.default(1800) }).prefault({}),
  concurrency: count.default(4),
}).prefault({});
const messagesSection = z.strictObject({
  conflict: messageFields.conflict.default(DEFAULT_MESSAGES.conflict),
  decisionAnswered: messageFields.decisionAnswered.default(DEFAULT_MESSAGES.decisionAnswered),
  merged: messageFields.merged.default(DEFAULT_MESSAGES.merged),
}).prefault({});
const retentionSection = z.strictObject({ endedPrDays: count.default(180), receivedEventDays: count.default(90) }).prefault({});
const routinesSection = z.strictObject({
  useDefaults: z.boolean().default(true), custom: z.array(routineSchema).default([]), deactivate: z.array(z.string().min(1)).default([]),
}).prefault({});

const overrideSchema = z.strictObject({
  match: z.strictObject({ providers: z.array(z.enum(PROVIDERS)).optional(), repos: z.array(z.string().min(1)).optional() }),
  set: z.strictObject({
    readiness: z.strictObject(readinessFields).partial().optional(),
    merge: z.strictObject(mergeFields).partial().optional(),
    workflows: z.strictObject({ ciFix: z.strictObject(ciFixFields).partial().optional() }).optional(),
    escalation: z.strictObject(escalationFields).partial().optional(),
    messages: z.strictObject(messageFields).partial().optional(),
  }).optional(),
});

type Issue = (path: Array<string | number>, text: string) => void;

/** The event types that the selected connector instances declare. */
function declaredTypes(config: z.output<ReturnType<typeof baseSchema>>, definitions: ReadonlyMap<string, ConnectorDefinition>, selected: readonly string[]): Set<string> {
  const types = new Set<string>();
  for (const id of selected) {
    const instance = Object.hasOwn(config.connectors, id) ? config.connectors[id] : undefined;
    for (const type of (instance && definitions.get(instance.use)?.emits) ?? []) types.add(type);
  }
  return types;
}

function checkRoutines(config: z.output<ReturnType<typeof baseSchema>>, definitions: ReadonlyMap<string, ConnectorDefinition>, issue: Issue): void {
  const instanceIds = Object.keys(config.connectors);
  const seen = new Set<string>();
  config.routines.custom.forEach((routine, index) => {
    const at = (...rest: Array<string | number>) => ["routines", "custom", index, ...rest];
    if (seen.has(routine.id)) issue(at("id"), `duplicates the routine id ${routine.id}`);
    seen.add(routine.id);
    for (const id of routine.when.connectors ?? []) {
      if (!Object.hasOwn(config.connectors, id)) issue(at("when", "connectors"), `${id} is not a configured connector`);
    }
    const declared = declaredTypes(config, definitions, routine.when.connectors ?? instanceIds);
    routine.when.on.forEach((name, position) => {
      if (name === "*" || (CORE_TRIGGERS as readonly string[]).includes(name) || declared.has(name)) return;
      issue(at("when", "on", position), `${name} is not an event type that the selected connectors declare`);
    });
    (routine.when.all ?? []).forEach((predicate, position) => {
      const fact: string = predicate.fact;
      const open = ["config.", "event.data."].find(prefix => fact.startsWith(prefix));
      if (open ? fact.length === open.length : !(FACT_NAMES as readonly string[]).includes(fact)) issue(at("when", "all", position, "fact"), `${fact} is not a known fact`);
    });
    routine.then.forEach((action, position) => {
      if (!("do" in action)) return;
      const checked = checkAction(action);
      if (!checked.ok) issue(at("then", position), checked.error);
    });
  });
  const defaultIds = new Set(DEFAULT_ROUTINES.map(routine => routine.id));
  config.routines.deactivate.forEach((id, index) => {
    if (!defaultIds.has(id)) issue(["routines", "deactivate", index], `${id} is not a default routine`);
  });
}

/** Everything but the connector registry and the cross-field checks. */
function baseSchema(definitions: ReadonlyMap<string, ConnectorDefinition>) {
  const connectors = z.record(kebab, instanceSchema).default({}).transform((record, ctx) => {
    const settled: Record<string, z.output<typeof instanceSchema>> = {};
    const settle = (id: string, settings: unknown, definition: ConnectorDefinition) => {
      const parsed = definition.settingsSchema.safeParse(settings);
      if (parsed.success) return parsed.data as Record<string, JsonValue>;
      for (const problem of parsed.error.issues) ctx.addIssue({ code: "custom", message: problem.message, path: [id, "settings", ...problem.path] });
      return {};
    };
    // The same rule for a written and a default instance; an empty default name means no secret, never "".
    const withSecret = (secretName: string | undefined, definition: ConnectorDefinition) => {
      const resolved = secretName ?? (definition.secret.defaultName || undefined);
      return resolved ? { secretName: resolved } : {};
    };
    for (const [id, instance] of Object.entries(record)) {
      const definition = definitions.get(instance.use);
      if (!definition) {
        ctx.addIssue({ code: "custom", message: `${instance.use} is not a registered connector`, path: [id, "use"] });
        settled[id] = instance;
      } else {
        const { secretName, ...rest } = instance;
        settled[id] = { ...rest, ...withSecret(secretName, definition), settings: settle(id, instance.settings, definition) };
      }
    }
    for (const definition of definitions.values()) {
      if (!definition.defaultInstance || Object.hasOwn(settled, definition.id)) continue;
      settled[definition.id] = {
        use: definition.id, enabled: definition.defaultInstance.enabled, ...withSecret(undefined, definition),
        settings: settle(definition.id, definition.defaultInstance.settings, definition),
      };
    }
    return settled;
  });
  return z.strictObject({
    enabled: z.boolean().default(false),
    connectors,
    readiness: readinessSection,
    merge: mergeSection,
    workflows: workflowsSection,
    escalation: escalationSection,
    commands: commandsSection,
    messages: messagesSection,
    retention: retentionSection,
    routines: routinesSection,
    overrides: z.array(overrideSchema).default([]),
  });
}

/** The config schema for a connector registry: each instance's settings are checked by its definition, and a routine may only listen to an event type that its connectors declare. */
export function createConfigSchema(connectors: readonly ConnectorDefinition[]) {
  const definitions = new Map(connectors.map(definition => [definition.id, definition as ConnectorDefinition]));
  return baseSchema(definitions).superRefine((config, ctx) => {
    const issue: Issue = (path, text) => ctx.addIssue({ code: "custom", message: text, path });
    checkRoutines(config, definitions, issue);
    if (resolveRoutines(config).length > MAX_ROUTINES) issue(["routines", "custom"], `at most ${MAX_ROUTINES} routines are allowed`);
  });
}

/** For tests that need no connectors. */
export const orchestratorConfigSchema = createConfigSchema([]);

type Assignable<T extends U, U> = T;
/** Compile-time check: the parsed document is an OrchestratorConfig. */
export type ParsedConfig = Assignable<z.output<typeof orchestratorConfigSchema>, OrchestratorConfig>;

export function parseOrchestratorConfig(text: string, connectors: readonly ConnectorDefinition[]): { ok: true; config: OrchestratorConfig } | { ok: false; error: string } {
  return parseWith(createConfigSchema(connectors), text);
}

function parseWith(schema: z.ZodType<OrchestratorConfig>, text: string): { ok: true; config: OrchestratorConfig } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = parseJson(text);
  } catch {
    return { ok: false, error: "the document is not valid JSON" };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, error: schemaIssue(parsed.error, "invalid document") };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
export const canonicalJson = (config: OrchestratorConfig) => JSON.stringify(canonical(config));

/** sha256 of the canonical JSON (keys sorted at every depth, arrays in order) of the effective document. */
export function configVersion(config: OrchestratorConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}

/** The default routines first, then the new custom ones. A custom routine with a default's id replaces it in place; a default in `deactivate` stays in the list as inactive. */
export function resolveRoutines(config: Pick<OrchestratorConfig, "routines">): Array<Routine & { source: "default" | "custom" }> {
  const { useDefaults, custom, deactivate } = config.routines;
  const off = new Set(deactivate);
  const customById = new Map(custom.map(routine => [routine.id, routine]));
  const defaultIds = new Set<string>(DEFAULT_ROUTINES.map(routine => routine.id));
  const resolved: Array<Routine & { source: "default" | "custom" }> = [];
  if (useDefaults) {
    for (const routine of DEFAULT_ROUTINES) {
      const replacement = customById.get(routine.id);
      const entry = replacement ? { ...replacement, source: "custom" as const } : { ...routine, source: "default" as const };
      resolved.push(off.has(routine.id) ? { ...entry, active: false } : entry);
    }
  }
  for (const routine of custom) {
    if (!useDefaults || !defaultIds.has(routine.id)) resolved.push({ ...routine, source: "custom" });
  }
  return resolved;
}

const isPlain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Objects merge key by key; arrays, null and scalars replace. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = deepMerge(base[key], value);
  }
  return merged;
}

/** The config for one repo: the tunables with the matching overrides applied in list order, and the resolved routines (their provider and repo filters are the evaluator's job). */
export function resolveForRepo(config: OrchestratorConfig, provider: Provider, repo: string): RepoConfig {
  let tunable: unknown = {
    readiness: config.readiness, merge: config.merge, workflows: config.workflows, escalation: config.escalation, messages: config.messages,
  } satisfies RepoTunable;
  for (const override of config.overrides) {
    const { providers, repos } = override.match;
    if (providers?.length && !providers.includes(provider)) continue;
    if (repos?.length && !anyGlob(repos, repo)) continue;
    tunable = deepMerge(tunable, override.set ?? {});
  }
  return {
    enabled: config.enabled, connectors: config.connectors, commands: config.commands, retention: config.retention,
    ...(tunable as RepoTunable), routines: resolveRoutines(config),
  };
}

/** JSON Schema of the document as the person writes it (defaults not applied). */
export function configJsonSchema(connectors: readonly ConnectorDefinition[]): Record<string, unknown> {
  return { ...z.toJSONSchema(createConfigSchema(connectors), { io: "input" }), $schema: JSON_SCHEMA_DRAFT };
}

export interface ConfigSourceOptions {
  path: () => string;
  /** Called once for each version that the source has not reported before, with the canonical JSON of that document. */
  onVersion(version: string, json: string): void;
  log(line: string): void;
  connectors: readonly ConnectorDefinition[];
}

type Loaded = { config: OrchestratorConfig; version: string; error: string | null };

/** Reads the file at every call through settledFileCache. A missing file gives the defaults; a broken one keeps the last valid config and reports the error. */
export function createConfigSource(opts: ConfigSourceOptions): { current(): Loaded } {
  const schema = createConfigSchema(opts.connectors);
  const reported = new Set<string>();
  let lastLogged: string | null = null;
  let valid: { config: OrchestratorConfig; version: string } | null = null;

  // Parsed and hashed once per document: current() runs several times per step.
  let empty: { config: OrchestratorConfig; version: string } | null = null;
  const defaults = () => {
    if (empty) return empty;
    const parsed = parseWith(schema, "{}");
    if (!parsed.ok) throw new Error(`the default document is invalid: ${parsed.error}`);
    empty = { config: parsed.config, version: configVersion(parsed.config) };
    return empty;
  };
  const cache = settledFileCache(opts.path, (): { ok: true; config: OrchestratorConfig; version: string } | { ok: false; error: string } | null => {
    let text: string;
    try {
      text = readFileSync(opts.path(), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? null : { ok: false, error: `cannot read the file (${code ?? "unknown error"})` };
    }
    const parsed = parseWith(schema, text);
    return parsed.ok ? { ...parsed, version: configVersion(parsed.config) } : parsed;
  });

  return {
    current() {
      const read = cache.read();
      let error: string | null = null;
      if (read === null) valid = defaults();
      else if (read.ok) valid = { config: read.config, version: read.version };
      else {
        error = read.error;
        valid ??= defaults();
        if (error !== lastLogged) opts.log(`pr-orchestrator config: ${error}`);
      }
      lastLogged = error;
      if (!reported.has(valid.version)) {
        reported.add(valid.version);
        opts.onVersion(valid.version, canonicalJson(valid.config));
      }
      return { config: valid.config, version: valid.version, error };
    },
  };
}
