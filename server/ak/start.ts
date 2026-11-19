import type { ExternalApprovals } from "../external-approvals.ts";
import type { AutoApprovalHistory, RequestOrigins } from "../paseo/auto-approval.ts";
import type { Notification } from "../notify.ts";
import { ensurePaseoBot, PASEO_BOT_ID } from "../paseo/gatekeeper.ts";
import type { Store } from "../store.ts";
import type { VaultStore } from "../vault-store.ts";
import { createAkCli, defaultAkRunner, type AkCli } from "./cli.ts";
import { createAkGuard } from "./guard.ts";
import { startInboxWatcher, type InboxWatcherDeps } from "./inbox-watcher.ts";
import { akRunnerFromEnv, remoteAkHost } from "./ssh-runner.ts";
import { startVaultSync } from "./vault-sync.ts";

export interface AkBridgeWiring {
  vault: Pick<VaultStore, "version" | "listSecrets" | "secret">;
  dataDir: string;
  store: Pick<Store, "bot" | "createBot">;
  approvals: ExternalApprovals;
  notify(notification: Notification | null): void;
  screenLocked(): Promise<boolean>;
  /** Names the Paseo agent behind a request, when one sent `ak secrets request` for the ref a moment ago. */
  origins?: Pick<RequestOrigins, "find">;
  /** Receives what was allowed without the person. */
  history?: AutoApprovalHistory;
  /** Tests give a fake; OpenMausBot uses the real `ak`. */
  cli?: AkCli;
  secretsDir?: string;
  /** Receives the live test for the refs this bridge owns, once the Vault sync is running. */
  /** Tells the Paseo agent that waited for an approval to go on. */
  notifyAgent?: InboxWatcherDeps["notifyAgent"];
  onOwns?(owns: (ref: string) => boolean): void;
}

/** Starts the Vault-to-ak sync and the inbox watcher. A missing or refusing `ak` is logged and never throws. */
export function startAkBridge(wiring: AkBridgeWiring, log: (message: string) => void): () => void {
  const guard = createAkGuard(log);
  const cli = wiring.cli ?? createAkCli(akRunnerFromEnv(process.env, () => defaultAkRunner()), { onUnknownShape: (keys) => log(`ak inbox: unexpected response shape, keys: ${keys.join(", ") || "(none)"}`) });
  // Made now, not on the first card: the Vault's bot picker can only offer the Paseo bot once it exists.
  ensurePaseoBot(wiring.store);
  const sync = startVaultSync({ vault: wiring.vault, cli, guard, dataDir: wiring.dataDir, botId: PASEO_BOT_ID, log });
  wiring.onOwns?.(sync.owns);
  const inbox = startInboxWatcher({
    cli,
    guard,
    approvals: wiring.approvals,
    owns: sync.owns,
    bot: () => ensurePaseoBot(wiring.store),
    notify: wiring.notify,
    screenLocked: wiring.screenLocked,
    log,
    // With ak on another device, this device has no ak files to watch or programs to hash.
    ...(remoteAkHost() !== null ? { remote: true } : {}),
    ...(wiring.notifyAgent ? { notifyAgent: wiring.notifyAgent } : {}),
    ...(wiring.origins ? { origins: wiring.origins } : {}),
    ...(wiring.history ? { history: wiring.history } : {}),
    ...(wiring.secretsDir ? { secretsDir: wiring.secretsDir } : {}),
  });
  return () => {
    sync.stop();
    inbox.stop();
  };
}
