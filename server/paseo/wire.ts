import type { RoutineManager } from "../routines.ts";
import type { Store } from "../store.ts";
import { formatAutoApproval, type AutoApprovalLine } from "./auto-approval.ts";
import { ensurePaseoBot } from "./gatekeeper.ts";
import { startPaseoBridge, type PaseoBridge, type PaseoBridgeWiring } from "./bridge.ts";
import { readScreenLocked } from "./screen-lock.ts";

/** What the Paseo bridge takes from the rest of the server. */
export type PaseoHost = Pick<PaseoBridgeWiring, "approvals" | "decider" | "notify"> & {
  /** The conversations: the Paseo bot lives here, and a Dispatcher is found by the thread it speaks in. */
  store: PaseoBridgeWiring["store"] & Pick<Store, "botByThread">;
  /** The Vault whose secrets kept to the Paseo bot are copied to `ak`. */
  vault: NonNullable<PaseoBridgeWiring["ak"]>["vault"];
  dataDir: string;
  /** Writes one line of what was allowed without asking into the Inbox as an already read line. */
  autoApproved(line: AutoApprovalLine): void;
  enqueueWebhook(input: Parameters<RoutineManager["enqueueWebhook"]>[0]): unknown;
};

/** The one call the server makes for Paseo: permissions, secret requests and Dispatcher wake-ups. Null when the bridge is off. */
export function startPaseo(host: PaseoHost, env: NodeJS.ProcessEnv = process.env): PaseoBridge | null {
  return startPaseoBridge(env, {
    store: host.store,
    approvals: host.approvals,
    decider: host.decider,
    notify: host.notify,
    screenLocked: readScreenLocked,
    history: (entry) => {
      const bot = ensurePaseoBot(host.store);
      host.autoApproved({ botId: bot.id, threadId: bot.threadId, key: entry.key, text: (count) => formatAutoApproval(entry, count) });
    },
    ak: { vault: host.vault, dataDir: host.dataDir },
    dispatcher: {
      store: host.store,
      wake: ({ botId, threadId, deliveryId, message }) => {
        host.enqueueWebhook({
          webhookId: "paseo-dispatcher", webhookName: "Paseo agent update", prompt: message, botId, runOn: "maus",
          deliveryId, receivedAt: Date.now(), eventSource: "wait", resultsThreadId: threadId,
        });
      },
    },
  });
}
