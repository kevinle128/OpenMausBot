import type { ExternalApprovals } from "../external-approvals.ts";
import type { Notification } from "../notify.ts";
import { ensurePaseoBot, PASEO_BOT_ID } from "../paseo/gatekeeper.ts";
import type { Store } from "../store.ts";
import type { VaultStore } from "../vault-store.ts";
import { createAkCli, type AkCli } from "./cli.ts";
import { createAkGuard } from "./guard.ts";
import { startInboxWatcher } from "./inbox-watcher.ts";
import { startVaultSync } from "./vault-sync.ts";

export interface AkBridgeWiring {
  vault: Pick<VaultStore, "version" | "listSecrets" | "secret">;
  dataDir: string;
  store: Pick<Store, "bot" | "createBot">;
  approvals: ExternalApprovals;
  notify(notification: Notification | null): void;
  screenLocked(): Promise<boolean>;
  /** Tests give a fake; OpenMausBot uses the real `ak`. */
  cli?: AkCli;
  secretsDir?: string;
}

/** Starts the Vault-to-ak sync and the inbox watcher. A missing or refusing `ak` is logged and never throws. */
export function startAkBridge(wiring: AkBridgeWiring, log: (message: string) => void): () => void {
  const guard = createAkGuard(log);
  const cli = wiring.cli ?? createAkCli(undefined, { onUnknownShape: (keys) => log(`ak inbox: unexpected response shape, keys: ${keys.join(", ") || "(none)"}`) });
  // Made now, not on the first card: the Vault's bot picker can only offer the Paseo bot once it exists.
  ensurePaseoBot(wiring.store);
  const sync = startVaultSync({ vault: wiring.vault, cli, guard, dataDir: wiring.dataDir, botId: PASEO_BOT_ID, log });
  const inbox = startInboxWatcher({
    cli,
    guard,
    approvals: wiring.approvals,
    owns: sync.owns,
    bot: () => ensurePaseoBot(wiring.store),
    notify: wiring.notify,
    screenLocked: wiring.screenLocked,
    log,
    ...(wiring.secretsDir ? { secretsDir: wiring.secretsDir } : {}),
  });
  return () => {
    sync.stop();
    inbox.stop();
  };
}
