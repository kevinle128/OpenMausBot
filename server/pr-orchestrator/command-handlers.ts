import { createHash } from "node:crypto";
import { serverLine, type ServerLineKey } from "../server-lines.ts";
import { stubHandlers, type CommandContext, type CommandHandler, type CommandHandlers } from "./handlers.ts";
import { renderMessage } from "./messages.ts";
import { ForgeNotReadyError, ForgeRefusedError, PortUnavailableError, type NoticeSubject } from "./ports.ts";
import type {
  AskKind, CommandPayload, CommandRecord, CommandResult, CommandWait, Owner, PrRecord, PrRef,
} from "./types.ts";

type Reply = CommandResult | CommandWait;
type PayloadOf<T extends CommandPayload["type"]> = Extract<CommandPayload, { type: T }>;

const skipped = (reason: string): CommandResult => ({ outcome: "skipped", reason });
const NOT_INSTALLED = skipped("not installed");
const ENDED = new Set(["merged", "closed"]);

export function prRef(record: PrRecord): PrRef {
  return {
    key: record.key, provider: record.provider, repo: record.repo, number: record.number,
    url: record.url, headSha: record.headSha, branch: record.branch, baseRef: record.baseRef,
  };
}

/** The head that a payload was built for; null when the payload does not depend on a head. */
function payloadHead(payload: CommandPayload): string | null {
  switch (payload.type) {
    case "Merge": return payload.expectedHeadSha;
    case "AskPerson": case "Notify": return null;
    default: return payload.headSha;
  }
}

function guard(command: CommandRecord, ctx: CommandContext, installed: boolean, endedPrOk: boolean): CommandResult | null {
  if (!installed) return NOT_INSTALLED;
  const { record } = ctx;
  if (record === null) return null;
  if (ENDED.has(record.state) && !endedPrOk) return skipped("PR ended");
  const head = payloadHead(command.payload);
  if (head !== null && head !== record.headSha) return skipped("head moved");
  return null;
}

const guardedForge = (command: CommandRecord, ctx: CommandContext): CommandResult | null => {
  if (ctx.record === null) return skipped("needs a PR subject");
  return guard(command, ctx, ctx.installed.forge(ctx.record.provider), false);
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function messageIdOf(command: CommandRecord, text: string): string {
  return `${command.id}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}

async function ownerOf(ctx: CommandContext, log: (line: string) => void): Promise<Owner | null> {
  const { record } = ctx;
  if (record === null) return null;
  if (record.owner) return record.owner;
  for (const link of ctx.ports.resolvers) {
    try {
      const found = await link.resolve(prRef(record));
      if (found === "next") continue;
      ctx.bindOwner(found);
      return found;
    } catch (error) {
      if (error instanceof PortUnavailableError) throw error;
      log(`pr-orchestrator: owner resolver ${link.name} failed: ${errorText(error)}`);
    }
  }
  return null;
}

async function tellOwner(command: CommandRecord, ctx: CommandContext, text: string): Promise<Reply> {
  const owner = await ownerOf(ctx, ctx.log);
  if (owner === null) return skipped("owner not found");
  const answer = await ctx.ports.runtime.send(owner, text, { messageId: messageIdOf(command, text) });
  return answer === "delivered" ? { outcome: "succeeded" } : skipped("owner session gone");
}

async function runInstruction(command: CommandRecord, payload: PayloadOf<"RunInstruction">, ctx: CommandContext): Promise<Reply> {
  const text = renderMessage(payload.prompt, payload.vars, payload.untrusted);
  if (payload.to === "owner") return tellOwner(command, ctx, text);
  const { record } = ctx;
  const known = record?.owner ?? null;
  const owner = known !== null && await ctx.ports.runtime.isAlive(known) ? known : null;
  const place = owner?.cwd ? { cwd: owner.cwd, workspaceId: owner.workspaceId } : { cwd: ctx.config.agents.newAgent.cwd, workspaceId: null };
  if (place.cwd === null) return skipped("no place to run a new agent");
  const harness = payload.harness ?? ctx.config.agents.newAgent.harness ?? owner?.harness ?? null;
  if (harness === null) return skipped("no harness for a new agent");
  const model = payload.model ?? ctx.config.agents.newAgent.model ?? owner?.model ?? null;
  await ctx.ports.runtime.spawn({
    requestId: command.id, cwd: place.cwd, workspaceId: place.workspaceId, harness, model, brief: text,
    labels: { "omb.command": command.id, ...(record ? { "omb.pr": `${record.repo}#${record.number}` } : {}) },
  });
  return { outcome: "succeeded" };
}

/** What a card shows. Pure: a restart rebuilds the same card from the command and the record. */
export function askCardOf(command: CommandRecord, ctx: Pick<CommandContext, "record" | "config" | "subjectLabel">):
  { subject: NoticeSubject; title: string; body: string; answers: Array<{ id: string; label: string }> } {
  const { payload } = command;
  if (payload.type !== "AskPerson") throw new TypeError(`${command.type} is not a question`);
  const { record } = ctx;
  const subject: NoticeSubject = { key: command.subjectKey, pr: record ? prRef(record) : null, label: ctx.subjectLabel };
  const line = (part: "title" | "body", params: Record<string, string | number>) =>
    serverLine(undefined, `server.prOrchestrator.card.${payload.kind}.${part}` as ServerLineKey, params);
  const base = { pr: ctx.subjectLabel, url: record?.url ?? "" };
  let params: Record<string, string | number>;
  let answers: Array<{ id: string; label: string }>;
  switch (payload.kind satisfies AskKind) {
    case "decision": {
      const review = record?.review ?? null;
      params = {
        ...base, title: record?.title ?? "", rounds: review?.rounds ?? 0, maxRounds: review?.maxRounds ?? 0,
        unresolved: review?.items.at(-1)?.unresolved ?? 0, commentUrl: review?.commentUrl ?? "",
      };
      answers = ctx.config.escalation.decisionChoices.map(choice => ({ id: choice, label: choice }));
      break;
    }
    case "command_failed":
      params = { ...base, command: payload.about?.command ?? "", reason: payload.about?.reason ?? "" };
      answers = [{ id: "understood", label: serverLine(undefined, "server.prOrchestrator.answer.understood") }];
      break;
    case "approve_action":
      params = { ...base, summary: payload.gated?.summary ?? "" };
      answers = [
        { id: "approve", label: serverLine(undefined, "server.prOrchestrator.answer.approve") },
        { id: "reject", label: serverLine(undefined, "server.prOrchestrator.answer.reject") },
      ];
      break;
  }
  return { subject, title: line("title", params), body: line("body", params), answers };
}

const tellOwnerHandler: CommandHandler = async (command, ctx) => {
  const early = guard(command, ctx, ctx.installed.runtime, true);
  if (early) return early;
  const payload = command.payload as PayloadOf<"TellOwner">;
  const text = renderMessage(ctx.config.messages[payload.template], payload.vars, payload.untrusted);
  return tellOwner(command, ctx, text);
};

const runInstructionHandler: CommandHandler = async (command, ctx) => {
  const early = guard(command, ctx, ctx.installed.runtime, false);
  return early ?? runInstruction(command, command.payload as PayloadOf<"RunInstruction">, ctx);
};

const askPersonHandler: CommandHandler = async (command, ctx) => {
  const early = guard(command, ctx, ctx.installed.notifier, false);
  if (early) return early;
  const { subject, title, body, answers } = askCardOf(command, ctx);
  const { decisionId } = command.payload as PayloadOf<"AskPerson">;
  const { cardId } = await ctx.ports.notifier.card((command.payload as PayloadOf<"AskPerson">).kind, { subject, title, body, decisionId }, answers);
  return { outcome: "succeeded", detail: { cardId } };
};

const notifyHandler: CommandHandler = async (command, ctx) => {
  const early = guard(command, ctx, ctx.installed.notifier, true);
  if (early) return early;
  const { kind } = command.payload as PayloadOf<"Notify">;
  const subject: NoticeSubject = { key: command.subjectKey, pr: ctx.record ? prRef(ctx.record) : null, label: ctx.subjectLabel };
  const text = serverLine(undefined, `server.prOrchestrator.notice.${kind}` as ServerLineKey, {
    pr: ctx.subjectLabel, url: ctx.record?.url ?? "", mergeSha: ctx.mergeSha,
  });
  await ctx.ports.notifier.notice(kind, text, subject);
  return { outcome: "succeeded" };
};

const mergeHandler: CommandHandler = async (command, ctx) => {
  const early = guardedForge(command, ctx);
  if (early) return early;
  const record = ctx.record as PrRecord;
  const { method, expectedHeadSha, deleteBranch } = command.payload as PayloadOf<"Merge">;
  try {
    const done = await ctx.ports.forge[record.provider].merge(prRef(record), { method, expectedHeadSha, deleteBranch });
    if (done.merged) return { outcome: "succeeded", detail: { merged: true, sha: done.sha } };
    return done.headMoved ? skipped("head moved") : { outcome: "failed", reason: done.reason, retryable: false };
  } catch (error) {
    if (error instanceof ForgeRefusedError) return { outcome: "failed", reason: error.message, retryable: false };
    throw error;
  }
};

const refreshDetailsHandler: CommandHandler = async (command, ctx) => {
  const early = guardedForge(command, ctx);
  if (early) return early;
  const record = ctx.record as PrRecord;
  const { headSha } = command.payload as PayloadOf<"RefreshDetails">;
  try {
    const details = await ctx.ports.forge[record.provider].details(prRef(record));
    return details.headSha === headSha ? { outcome: "succeeded", detail: { forge: details } } : skipped("head moved");
  } catch (error) {
    if (error instanceof ForgeNotReadyError) return { outcome: "waiting", reason: error.message, retryAfterSeconds: ctx.wait.forgeSeconds };
    if (error instanceof ForgeRefusedError) return { outcome: "failed", reason: error.message, retryable: false };
    throw error;
  }
};

/** The handlers that call the ports. A port with no adapter gives "not installed"; RunWorkflow keeps its stub until a workflow adapter exists. */
export function portHandlers(): CommandHandlers {
  return {
    ...stubHandlers(),
    TellOwner: tellOwnerHandler, AskPerson: askPersonHandler, Notify: notifyHandler, Merge: mergeHandler,
    RefreshDetails: refreshDetailsHandler, RunInstruction: runInstructionHandler,
  };
}
