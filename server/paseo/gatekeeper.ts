import type { Decider } from "../decider/index.ts";
import type { ExternalApprovals } from "../external-approvals.ts";
import { buildNotification, type Notification } from "../notify.ts";
import type { BotRecord, Store } from "../store.ts";
import type { PaseoConnection, PaseoPermissionRequested } from "./connection.ts";
import { classifyPermission, permissionTarget } from "./permission-rules.ts";

export const PASEO_BOT_ID = "paseo-gatekeeper";
const PASEO_BOT_NAME = "Paseo";
export const JEV_TIMEOUT_MS = 1_000;
export const JEV_MIN_PROBABILITY = 0.9;
const SUBTITLE_CHARS = 600;

export const JEV_INSTRUCTIONS =
  "A coding agent asks to run the shell command in `command`, in the directory `cwd`. Answer yes only when everything the " +
  "command does is one of two things: reading an environment file (a file named .env or .env.something), or running `ak secrets` " +
  "with a read-only subcommand (get, list, search, describe, request, resolve, audit or grants), with the output staying on the " +
  "screen. Answer no when any step writes, deletes or changes anything, runs another program that could send data out, sends " +
  "anything over a network, or when you are not sure.";

type DeciderPort = Pick<Decider, "yesNo">;

export interface PaseoGatekeeperDeps {
  connection: Pick<PaseoConnection, "on" | "off" | "respondToPermission">;
  store: Pick<Store, "bot" | "createBot" | "messagesFor" | "patchMessage" | "appendMessage">;
  approvals: ExternalApprovals;
  decider: DeciderPort;
  notify(notification: Notification | null): void;
  screenLocked(): Promise<boolean>;
  log(message: string): void;
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

  function paseoBot(): BotRecord {
    const existing = store.bot(PASEO_BOT_ID);
    if (existing) return existing as BotRecord;
    return store.createBot(
      { name: PASEO_BOT_NAME, description: "Permission requests from your Paseo coding agents." },
      { id: PASEO_BOT_ID, seedMessages: false },
    );
  }

  async function jevAllows(command: string, cwd: string, provider: string): Promise<boolean> {
    try {
      const result = await decider.yesNo("paseoPermission", { command, cwd, provider }, JEV_INSTRUCTIONS, { timeoutMs: JEV_TIMEOUT_MS });
      if (!result.ok) {
        deps.log(`paseo gatekeeper: Jev gave no answer (${result.reason}); asking the person`);
        return false;
      }
      return result.answers.p >= JEV_MIN_PROBABILITY;
    } catch {
      return false;
    }
  }

  function describe({ agent, request }: PaseoPermissionRequested): { label: string; what: string } {
    const target = permissionTarget(request);
    const what = target ? (target.kind === "command" ? target.command : target.filePath) : request.title ?? request.description ?? request.name;
    return { label: agent.title?.trim() || agent.id.slice(0, 8), what };
  }

  async function ask(event: PaseoPermissionRequested, key: string): Promise<void> {
    const { agentId, request, agent } = event;
    const { label, what } = describe(event);
    const bot = paseoBot();
    const respond = async (decision: "allow" | "deny") => {
      const action = request.actions?.find((candidate) => candidate.behavior === decision);
      await connection.respondToPermission(agentId, request.id, { behavior: decision, ...(action ? { selectedActionId: action.id } : {}) });
    };
    const opened = approvals.open({
      key,
      threadId: bot.threadId,
      title: "A Paseo agent needs your approval",
      subtitle: `${oneLine(`${label} · ${agent.cwd}`, 200)}\n${oneLine(what, SUBTITLE_CHARS)}`,
      tool: request.name,
      onAnswer: respond,
    });
    if (!opened) return;
    deps.log(`paseo gatekeeper: asked the person about request ${request.id} of agent ${agentId}`);
    if (await deps.screenLocked().catch(() => false)) {
      deps.notify(buildNotification("approval", bot, bot.threadId, oneLine(`${label}: ${what}`, 200)));
    }
  }

  async function handle(event: PaseoPermissionRequested): Promise<void> {
    const { agentId, request, agent } = event;
    const key = keyOf(agentId, request.id);
    if (stages.has(key)) return;
    stages.set(key, "deciding");
    try {
      const decision = classifyPermission(request);
      let allowed = decision.verdict === "allow";
      let rule = decision.rule;
      if (decision.verdict === "ambiguous") {
        const target = permissionTarget(request);
        allowed = target?.kind === "command" && (await jevAllows(target.command, agent.cwd, agent.provider));
        rule = allowed ? "jev-allowed" : "jev-not-allowed";
      }
      if (stages.get(key) === "resolved") {
        stages.delete(key);
        return;
      }
      stages.set(key, "settled");
      if (allowed) {
        const action = request.actions?.find((candidate) => candidate.behavior === "allow");
        await connection.respondToPermission(agentId, request.id, { behavior: "allow", ...(action ? { selectedActionId: action.id } : {}) });
        deps.log(`paseo gatekeeper: allowed request ${request.id} of agent ${agentId} (${rule})`);
        return;
      }
      if (request.kind === "question") {
        deps.log(`paseo gatekeeper: request ${request.id} of agent ${agentId} is a question; it is answered in Paseo`);
        return;
      }
      await ask(event, key);
    } catch (error) {
      deps.log(`paseo gatekeeper: request ${request.id} of agent ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (stages.get(key) === "settled") await ask(event, key).catch(() => {});
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
    for (const key of stages.keys()) {
      if (live.has(key)) continue;
      if (stages.get(key) === "deciding") stages.set(key, "resolved");
      else stages.delete(key);
    }
    for (const key of approvals.keys()) if (!live.has(key)) approvals.close(key);
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
