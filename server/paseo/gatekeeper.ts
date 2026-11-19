import { redactSecretsInText } from "../../shared/redact.ts";
import type { Decider } from "../decider/index.ts";
import type { ExternalApprovals } from "../external-approvals.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { BotRecord, Store } from "../store.ts";
import type { PaseoConnection, PaseoPermissionRequested } from "./connection.ts";
import type { AutoApprovalHistory, PersonAnswer, RequestOrigins } from "./auto-approval.ts";
import { approvingOption, createJevGuard, scoresLine, type AgentContext, type GuardOutcome } from "./jev-guard.ts";
import { classifyPermission, permissionTarget } from "./permission-rules.ts";
import { APPROVE_ONCE, hookReadQuestion, hookReadShape, questionAnswer, readQuestions, type PaseoQuestion } from "./question-rules.ts";

export const PASEO_BOT_ID = "paseo-gatekeeper";
const PASEO_BOT_NAME = "Paseo";
const SUBTITLE_CHARS = 600;
const MAX_QUESTION_CHOICES = 6;
const MAX_CHOICE_CHARS = 120;
/** The one button of a question card the person cannot answer here: the agent's question stays in Paseo. */
export const ANSWER_IN_PASEO = "Answer in Paseo";
/** Paseo puts this label on an agent that another agent created. */
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

/** The Paseo conversation's bot, made on first use. */
export function ensurePaseoBot(store: Pick<Store, "bot" | "createBot">): BotRecord {
  const existing = store.bot(PASEO_BOT_ID);
  if (existing) return existing as BotRecord;
  return store.createBot(
    { name: PASEO_BOT_NAME, description: "Permission requests and secret requests from your Paseo coding agents." },
    { id: PASEO_BOT_ID, seedMessages: false },
  );
}

type DeciderPort = Pick<Decider, "ask">;

export interface PaseoGatekeeperDeps {
  connection: Pick<PaseoConnection, "on" | "off" | "respondToPermission" | "inspectPath">;
  store: Pick<Store, "bot" | "createBot" | "messagesFor" | "patchMessage" | "appendMessage">;
  approvals: ExternalApprovals;
  decider: DeciderPort;
  notify(notification: Notification | null): void;
  screenLocked(): Promise<boolean>;
  log(message: string): void;
  /** Called for everything this gatekeeper allowed without the person, so the Inbox can list it. */
  history?: AutoApprovalHistory;
  /** Told of each `ak secrets request` command, so its later approval can name the agent that asked. */
  origins?: Pick<RequestOrigins, "note">;
  /** True for an `ak` ref OpenMausBot owns: an `ak secrets run` that names only such refs is allowed. */
  ownsRef?: (ref: string) => boolean;
  /** The agent's first prompt and last tool calls, for Jev Guard. Without it Jev judges the call alone. */
  agentContext?(agentId: string): Promise<AgentContext | null>;
}

type Stage = "deciding" | "settled" | "resolved";

const oneLine = (value: string, max: number): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Decides each permission a Paseo agent asks for: lets the two kinds of secret reading go, and puts everything else on
 * a card in the Paseo conversation. Returns a function that stops listening. */
export function startPaseoGatekeeper(deps: PaseoGatekeeperDeps): () => void {
  const { connection, store, approvals, decider } = deps;
  const stages = new Map<string, Stage>();
  const keyOf = (agentId: string, requestId: string) => `${agentId}/${requestId}`;

  const paseoBot = () => ensurePaseoBot(store);

  const guard = createJevGuard({
    decider,
    log: (message) => deps.log(message),
    ...(deps.agentContext ? { agentContext: deps.agentContext } : {}),
  });

  function describe({ agent, request }: PaseoPermissionRequested): { label: string; what: string } {
    const target = permissionTarget(request);
    const shown = target ? (target.kind === "command" ? target.command : target.filePath) : request.title ?? request.description ?? request.name;
    // The card and the lock-screen notice leave this process's trust boundary; a command can carry a key inline.
    const what = redactSecretsInText(shown);
    return { label: agent.title?.trim() || agent.id.slice(0, 8), what };
  }

  /** The question a card can answer with one tap: one question, one choice, and plain buttons. Null otherwise. */
  function tappable(questions: PaseoQuestion[] | null): PaseoQuestion | null {
    const only = questions?.length === 1 ? questions[0]! : null;
    if (!only || only.multiSelect || only.labels.length === 0 || only.labels.length > MAX_QUESTION_CHOICES) return null;
    // A label goes back to the agent as written, so a label that would need hiding is not offered as a button.
    return only.labels.every((choice) => choice.length <= MAX_CHOICE_CHARS && redactSecretsInText(choice) === choice) ? only : null;
  }

  async function ask(event: PaseoPermissionRequested, key: string, highRisk?: string): Promise<void> {
    const { agentId, request, agent } = event;
    const isQuestion = request.kind === "question";
    const questions = isQuestion ? readQuestions(request) : null;
    const single = tappable(questions);
    const { label, what: described } = describe(event);
    const what = questions?.[0] ? redactSecretsInText(`${questions[0].question}${questions.length > 1 ? ` (+${questions.length - 1} more)` : ""}`) : described;
    const bot = paseoBot();
    const respond = async (decision: "allow" | "deny") => {
      const action = request.actions?.find((candidate) => candidate.behavior === decision);
      await connection.respondToPermission(agentId, request.id, { behavior: decision, ...(action ? { selectedActionId: action.id } : {}) });
    };
    const opened = approvals.open({
      key,
      threadId: bot.threadId,
      title: `${isQuestion ? "A Paseo agent asks you a question" : "A Paseo agent needs your approval"}${highRisk ? " · Jev: high risk" : ""}`,
      subtitle: `${oneLine(`${label} · ${agent.cwd}`, 200)}\n${oneLine(what, SUBTITLE_CHARS)}${highRisk ? `\nJev: high risk, because ${highRisk}.` : ""}`,
      tool: request.name,
      ...(isQuestion ? { choices: single ? single.labels : [ANSWER_IN_PASEO], ...(single ? {} : { leave: ANSWER_IN_PASEO }) } : {}),
      onAnswer: async (decision, choice) => {
        if (!isQuestion) {
          await respond(decision);
          record(event, permissionTarget(request), "person", { answer: { decision } });
        } else if (single && choice !== undefined) {
          await connection.respondToPermission(agentId, request.id, questionAnswer(request, single.question, choice));
          record(event, null, "person", { shown: single.question, answer: { choice } });
        }
      },
    });
    if (!opened) return;
    deps.log(`paseo gatekeeper: asked the person about request ${request.id} of agent ${agentId}`);
    if (await deps.screenLocked().catch(() => false)) {
      deps.notify(buildNotification(isQuestion ? "question" : "approval", bot, bot.threadId, oneLine(`${label}: ${what}`, 200)));
    }
  }

  /** One line for the Inbox: the agent, where it works, what it was allowed to do and which rule allowed it. */
  function record(event: PaseoPermissionRequested, target: ReturnType<typeof permissionTarget>, rule: string, extra: { shown?: string; detail?: string; answer?: PersonAnswer } = {}): void {
    if (!deps.history) return;
    const { agentId, agent } = event;
    // The line leaves this process's trust boundary like a card does; a command can carry a key inline.
    const shown = extra.shown ?? (target ? (target.kind === "command" ? target.command : target.filePath) : event.request.title ?? event.request.description ?? event.request.name);
    const what = redactSecretsInText(oneLine(target?.kind === "file" ? `đọc file ${shown}` : shown, SUBTITLE_CHARS));
    try {
      // Each answer of the person is its own line; only what was allowed without asking merges repeats.
      const key = extra.answer ? `${agentId}|${event.request.id}|answer` : `${agentId}|${what}`;
      deps.history({ key, agent: describe(event).label, workspace: agent.cwd, what, rule, ...(extra.detail ? { detail: extra.detail } : {}), ...(extra.answer ? { answer: extra.answer } : {}) });
    } catch (error) {
      deps.log(`paseo gatekeeper: could not write the history line: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** What Jev Guard is asked about: a tool call, or a question with one plain yes option. Null for anything else. */
  function guardSubject(event: PaseoPermissionRequested, target: ReturnType<typeof permissionTarget>): { input: string; shown?: string; choice: string | null } | null {
    const { request } = event;
    if (request.kind === "tool") {
      const input = target ? (target.kind === "command" ? target.command : `read ${target.filePath}`) : JSON.stringify(request.input ?? request.title ?? request.name);
      return { input, choice: null };
    }
    if (request.kind !== "question") return null;
    const single = tappable(readQuestions(request));
    const choice = single ? approvingOption(single.labels) : null;
    if (!single || choice === null) return null;
    const asked = `${single.question} [options: ${single.labels.join(" | ")}] [the guard would pick: ${choice}]`;
    return { input: asked, shown: single.question, choice };
  }

  async function handle(event: PaseoPermissionRequested): Promise<void> {
    const { agentId, request, agent } = event;
    const key = keyOf(agentId, request.id);
    if (stages.has(key)) return;
    stages.set(key, "deciding");
    let asked = false;
    try {
      const target = permissionTarget(request);
      if (target?.kind === "command") deps.origins?.note(target.command, { agentId, agent: describe(event).label, cwd: agent.cwd });
      // The privacy hook asks before an agent reads a file; that one question is answered here, every other one is not.
      // The agent's files are on the agent's machine, so every file check asks the daemon there.
      const rules = { cwd: agent.cwd, inspectPath: (cwd: string, path: string) => connection.inspectPath(cwd, path), ...(deps.ownsRef ? { ownsRef: deps.ownsRef } : {}) };
      const hookRead = await hookReadQuestion(request, rules);
      // A hook read question whose file is not a plain file there (a link, a missing path, a daemon that cannot tell) is for the
      // person alone: Jev Guard would pick "Yes, approve once" without seeing what is at the path.
      const decision = hookRead ? { verdict: "allow" as const, rule: "hook-read-question" }
        : hookReadShape(request) ? { verdict: "ask" as const, rule: "hook-read-unchecked", hazard: true as const }
        : await classifyPermission(request, rules);
      let allowed = decision.verdict === "allow";
      let rule = decision.rule;
      let verdict: GuardOutcome | null = null;
      let choice: string | null = null;
      let shown: string | undefined;
      // A refusal for a hidden hazard is for the person alone: no model is asked to overrule it.
      if (!allowed && !("hazard" in decision && decision.hazard)) {
        // What the fixed rules did not allow goes to Jev Guard: a tool call, or a question with one plain yes option.
        const subject = guardSubject(event, target);
        if (subject) {
          choice = subject.choice;
          shown = subject.shown;
          verdict = await guard.assess({ agentId, agentTitle: describe(event).label, tool: request.name, input: subject.input, cwd: agent.cwd, createdByAgent: Boolean(agent.labels?.[PARENT_AGENT_LABEL]) });
          allowed = verdict.level === "allow";
          rule = "jev-guard";
        }
      }
      if (stages.get(key) === "resolved") {
        stages.delete(key);
        return;
      }
      stages.set(key, "settled");
      if (allowed) {
        const action = request.actions?.find((candidate) => candidate.behavior === "allow");
        const only = choice !== null ? readQuestions(request)?.[0] : undefined;
        await connection.respondToPermission(
          agentId,
          request.id,
          hookRead ? questionAnswer(request, hookRead.question, APPROVE_ONCE)
            : only && choice !== null ? questionAnswer(request, only.question, choice)
            : { behavior: "allow", ...(action ? { selectedActionId: action.id } : {}) },
        );
        deps.log(`paseo gatekeeper: allowed request ${request.id} of agent ${agentId} (${rule})`);
        record(event, hookRead ? { kind: "file", filePath: hookRead.filePath } : target, rule, {
          ...(shown ? { shown } : {}),
          ...(verdict?.scores ? { detail: scoresLine(verdict.scores) } : {}),
        });
        return;
      }
      asked = true;
      await ask(event, key, verdict?.level === "deny" ? verdict.why ?? "the call could do serious harm" : undefined);
    } catch (error) {
      deps.log(`paseo gatekeeper: request ${request.id} of agent ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
      // A card that failed to open is logged above; only an allow the daemon refused still needs its card.
      if (stages.get(key) === "settled" && !asked) {
        await ask(event, key).catch((askError: unknown) => {
          deps.log(`paseo gatekeeper: could not open a card for request ${request.id} of agent ${agentId}: ${askError instanceof Error ? askError.message : String(askError)}`);
        });
      }
    }
  }

  const onRequested = (event: PaseoPermissionRequested) => void handle(event);
  const onResolved = ({ agentId, requestId }: { agentId: string; requestId: string }) => {
    const key = keyOf(agentId, requestId);
    if (stages.get(key) === "deciding") stages.set(key, "resolved");
    else stages.delete(key);
    approvals.close(key);
  };
  const onSynced = ({ pending, complete }: { pending: Array<{ agentId: string; requestId: string }>; complete: boolean }) => {
    if (!complete) return;
    const live = new Set(pending.map((entry) => keyOf(entry.agentId, entry.requestId)));
    // Cards of other sources share the approvals list; only the ones this gatekeeper opened are its to close.
    const ownCards = approvals.keys().filter((key) => stages.has(key));
    for (const key of stages.keys()) {
      if (live.has(key)) continue;
      if (stages.get(key) === "deciding") stages.set(key, "resolved");
      else stages.delete(key);
    }
    for (const key of ownCards) if (!live.has(key)) approvals.close(key);
  };

  const existing = store.bot(PASEO_BOT_ID);
  if (existing) approvals.dismissStale(existing.threadId);
  connection.on("permissionRequested", onRequested);
  connection.on("permissionResolved", onResolved);
  connection.on("permissionsSynced", onSynced);
  return () => {
    connection.off("permissionRequested", onRequested);
    connection.off("permissionResolved", onResolved);
    connection.off("permissionsSynced", onSynced);
  };
}
