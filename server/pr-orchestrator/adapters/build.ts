import type { PaseoConnection } from "../../paseo/connection.ts";
import type { ExternalApprovals } from "../../external-approvals.ts";
import type { Notification } from "../../notify.ts";
import type { Store } from "../../store.ts";
import type { OrchestratorConfig, SubjectKey } from "../types.ts";
import { forgeAdapters } from "./forge-factory.ts";
import { inboxNotifier } from "./inbox-factory.ts";
import { paseoRuntime } from "./paseo-factory.ts";
import type { AttachedAdapters } from "./switched.ts";

/** What the Inbox adapter needs from the server: the bot store, the card owner and the notifier. */
export interface InboxParts {
  store: Pick<Store, "bot" | "createBot" | "messagesFor" | "patchMessage" | "appendMessage">;
  approvals: ExternalApprovals;
  notify(notification: Notification | null, how?: { routine?: boolean }): void;
}

/** What the server hands to the host once, at start-up. An install without Paseo or without the Inbox gets no such adapter. */
export interface AttachParts {
  paseo?: PaseoConnection | null;
  inbox?: InboxParts;
}

/** What an adapter needs from the host. */
export interface AdapterContext {
  log(line: string): void;
  now(): number;
  /** The live config of the core that runs now; the defaults when none runs. */
  config(): OrchestratorConfig;
  /** A team Vault secret by name, or null. Never log or keep the value. */
  secret(name: string): string | null;
  /** Delivers a person's answer to the core that runs now. */
  answer(subjectKey: SubjectKey, decisionId: string, answer: string): void;
}

/** Builds every adapter this install can have. The host calls it once; a switch decides later whether a port uses its adapter. */
export function buildAdapters(parts: AttachParts, ctx: AdapterContext): AttachedAdapters & { stop(): void } {
  const runtime = paseoRuntime(parts.paseo ?? null, ctx);
  return {
    forge: forgeAdapters(ctx), notifier: inboxNotifier(parts.inbox ?? null, ctx),
    runtime: runtime?.runtime ?? null, resolvers: runtime?.resolvers ?? [], stop: () => runtime?.stop(),
  };
}
