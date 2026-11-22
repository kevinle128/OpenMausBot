import { z } from "zod";
import { schemaIssue } from "../schema.ts";
import { renderMessage, samplePlaceholders } from "./messages.ts";
import { ACTION_TYPES, ASK_KINDS, NOTICE_KINDS, TEMPLATE_IDS, type ActionType, type CommandAction, type CommandType, type JsonValue } from "./types.ts";

type Params = Record<string, JsonValue>;

export interface ActionDefinition {
  type: ActionType;
  command: CommandType;
  /** "pr": needs a PR subject; "any": works on every subject (Instruct decides by params.to). */
  subjects(params: Params): "pr" | "any";
  /** Zod schema of params; absent params parse as {}. */
  params: z.ZodType;
  /** The editor's sentence for one action, for example "run workflow ci-fix (one active run per PR)". */
  describe(params: Params): string;
  /** For a long-running action: the target that the single-active-run guard keys on, per PR. */
  guard?(params: Params): string;
}

/** A param that reads its value from the repo config when the payload is built. */
const configRef = z.strictObject({ config: z.string().min(1) });
const orConfig = <T extends z.ZodType>(schema: T) => z.union([schema, configRef]);

/** A message or prompt template of at most `max` characters; an unknown placeholder is an error. */
export const templateText = (max: number) =>
  z.string().min(1).max(max).superRefine((text, ctx) => {
    const { vars, untrusted } = samplePlaceholders();
    try {
      renderMessage(text, vars, untrusted);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "cannot be rendered" });
    }
  });

const noParams = z.strictObject({});

/** The text of a param for a sentence: its value, or "config <path>" when it comes from the config. */
function show(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.config === "string") return `config ${value.config}`;
  return "?";
}

export const ACTION_REGISTRY: Readonly<Record<ActionType, ActionDefinition>> = {
  TellOwner: {
    type: "TellOwner",
    command: "TellOwner",
    subjects: () => "pr",
    params: z.strictObject({ template: orConfig(z.enum(TEMPLATE_IDS)) }),
    describe: params => `tell the owner session with the ${show(params.template)} message, if the owner is found`,
  },
  AskPerson: {
    type: "AskPerson",
    command: "AskPerson",
    subjects: () => "any",
    // approve_action is raised by the core for an action held with askFirst, and is never a routine's choice.
    params: z.strictObject({ kind: orConfig(z.enum(ASK_KINDS.filter(kind => kind !== "approve_action") as ["decision", "command_failed"])) }),
    describe: params => `ask the person (${show(params.kind)})`,
  },
  Notify: {
    type: "Notify",
    command: "Notify",
    subjects: () => "any",
    params: z.strictObject({ kind: orConfig(z.enum(NOTICE_KINDS)) }),
    describe: params => `send the person a ${show(params.kind)} notice`,
  },
  Merge: {
    type: "Merge",
    command: "Merge",
    subjects: () => "pr",
    params: noParams,
    describe: () => "merge the PR",
  },
  RefreshDetails: {
    type: "RefreshDetails",
    command: "RefreshDetails",
    subjects: () => "pr",
    params: noParams,
    describe: () => "read the forge facts for the head",
  },
  RunWorkflow: {
    type: "RunWorkflow",
    command: "RunWorkflow",
    subjects: () => "pr",
    params: z.strictObject({
      workflow: orConfig(z.string().min(1).max(200)),
      message: orConfig(templateText(8000)),
      connection: orConfig(z.string().min(1)).nullable().optional(),
    }),
    describe: params => `run workflow ${show(params.workflow)} (one active run per PR)`,
    guard: params => `workflow:${show(params.workflow)}`,
  },
  Instruct: {
    type: "Instruct",
    command: "RunInstruction",
    subjects: params => (params.to === "owner" ? "pr" : "any"),
    params: z.strictObject({
      to: orConfig(z.enum(["owner", "new-agent"])),
      prompt: orConfig(templateText(8000)),
      harness: orConfig(z.string().min(1)).optional(),
      model: orConfig(z.string().min(1)).optional(),
    }),
    describe: params => `instruct ${params.to === "owner" ? "the owner session" : "a new agent"}`,
  },
};

/** Checks one routine action against its registry entry; the parsed params come back with defaults applied. */
export function checkAction(action: CommandAction): { ok: true; params: Params } | { ok: false; error: string } {
  const definition = (ACTION_REGISTRY as Record<string, ActionDefinition | undefined>)[action.do];
  if (!definition) return { ok: false, error: `unknown action ${String(action.do)}` };
  const parsed = definition.params.safeParse(action.params ?? {});
  if (!parsed.success) return { ok: false, error: `${action.do}: ${schemaIssue(parsed.error, "invalid params")}` };
  return { ok: true, params: parsed.data as Params };
}

/** What an editor needs to offer each action type: its command and the JSON Schema of its params. */
export function actionTypesForEditor(): Array<{ type: ActionType; command: CommandType; paramsSchema: Record<string, unknown> }> {
  return ACTION_TYPES.map(type => {
    const { $schema: _schema, ...paramsSchema } = z.toJSONSchema(ACTION_REGISTRY[type].params, { io: "input" }) as Record<string, unknown>;
    return { type, command: ACTION_REGISTRY[type].command, paramsSchema };
  });
}
