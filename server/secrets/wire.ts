import type { ExternalApprovals } from "../external-approvals.ts";
import type { Notification } from "../notify.ts";
import { formatAutoApproval, type AutoApprovalLine } from "../paseo/auto-approval.ts";
import { ensurePaseoBot } from "../paseo/gatekeeper.ts";
import { readScreenLocked } from "../paseo/screen-lock.ts";
import { createSecretsRoutes } from "../routes/secrets.ts";
import type { Store } from "../store.ts";
import type { VaultStore } from "../vault-store.ts";
import { createSecretsService } from "./service.ts";

export interface SecretsHost {
  vault: Pick<VaultStore, "listSecrets" | "secret" | "saveSecret" | "updateSecret" | "removeSecret" | "markUsed">;
  dataDir: string;
  approvals: Pick<ExternalApprovals, "open" | "close">;
  store: Pick<Store, "bot" | "createBot">;
  notify(notification: Notification | null): void;
  /** Writes one line of what was allowed without asking into the Inbox as an already read line. */
  autoApproved(line: AutoApprovalLine): void;
  botExists(id: string): boolean;
  /** A Team Cloud: the routes refuse. */
  team: boolean;
}

/** The `omb secrets` service, and the route handler the server registers for it. */
export function createSecrets(host: SecretsHost) {
  const service = createSecretsService({
    vault: host.vault,
    dataDir: host.dataDir,
    approvals: host.approvals,
    paseoBot: () => ensurePaseoBot(host.store),
    history: (entry) => {
      const bot = ensurePaseoBot(host.store);
      host.autoApproved({ botId: bot.id, threadId: bot.threadId, key: entry.key, text: (count) => formatAutoApproval(entry, count) });
    },
    notify: host.notify,
    screenLocked: readScreenLocked,
    botExists: host.botExists,
    log: (message) => console.warn(message),
  });
  return { service, routes: createSecretsRoutes({ service, team: host.team }) };
}
