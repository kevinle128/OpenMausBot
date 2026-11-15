import { startAkBridge, type AkBridgeWiring } from "../ak/start.ts";
import { createApprovalNotifier } from "./approval-notice.ts";
import { createRequestOrigins } from "./auto-approval.ts";
import { PaseoConnection } from "./connection.ts";
import { startDispatcherWake, type DispatcherWakeDeps } from "./dispatcher-wake.ts";
import { startPaseoGatekeeper, type PaseoGatekeeperDeps } from "./gatekeeper.ts";

export type PaseoBridgeWiring = Omit<PaseoGatekeeperDeps, "connection" | "log" | "origins" | "ownsRef" | "agentContext"> & {
  /** With this, the Vault is copied to `ak` for the Paseo agents and their secret requests are answered. */
  ak?: Pick<AkBridgeWiring, "vault" | "dataDir" | "cli" | "secretsDir">;
  /** With this, a Paseo agent a Dispatcher bot created wakes that bot's thread when it finishes or fails. */
  dispatcher?: Pick<DispatcherWakeDeps, "store" | "wake">;
};

export interface PaseoBridge {
  connection: PaseoConnection;
  /** Stops the gatekeeper, the Dispatcher wake and the ak bridge, then closes the connection to the daemon. */
  stop(): Promise<void>;
}

/**
 * The worker that keeps one connection to the Paseo daemon. It is off unless OMB_PASEO_BRIDGE=1, and a daemon that is
 * down or refuses the credential only delays it: the connection retries with a growing wait and never stops OMB.
 * With `wiring`, the permissions its agents ask for are decided as they arrive.
 */
export function startPaseoBridge(env: NodeJS.ProcessEnv = process.env, wiring?: PaseoBridgeWiring): PaseoBridge | null {
  if (env.OMB_PASEO_BRIDGE !== "1") return null;
  const log = (message: string) => console.log(message);
  const connection = new PaseoConnection({
    ...(env.OMB_PASEO_URL ? { url: env.OMB_PASEO_URL } : {}),
    log,
  });
  connection.on("error", (error) => console.error("paseo bridge: listener failed", error));
  const stops: Array<() => void> = [];
  if (wiring) {
    const { ak, dispatcher, ...gatekeeper } = wiring;
    const origins = createRequestOrigins();
    // The Vault sync starts after the gatekeeper; until it has, no ref is owned.
    const notifier = createApprovalNotifier({ connection, origins, log });
    stops.push(() => notifier.stop());
    let owns: (ref: string) => boolean = () => false;
    stops.push(startPaseoGatekeeper({ ...gatekeeper, connection, log, origins, ownsRef: (ref) => owns(ref), agentContext: (agentId) => connection.agentContext(agentId) }));
    if (dispatcher) stops.push(startDispatcherWake({ ...dispatcher, connection, log }));
    // After the gatekeeper, which closes the cards an earlier run left open.
    if (ak) {
      try {
        stops.push(startAkBridge({ ...ak, store: wiring.store, approvals: wiring.approvals, notify: wiring.notify, screenLocked: wiring.screenLocked, origins, notifyAgent: (approved) => notifier.approved(approved), onOwns: (fn) => { owns = fn; }, ...(wiring.history ? { history: wiring.history } : {}) }, log));
      } catch (error) {
        log(`ak bridge: could not start (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }
  connection.start();
  return {
    connection,
    async stop() {
      for (const stop of stops.splice(0).reverse()) {
        try {
          stop();
        } catch (error) {
          log(`paseo bridge: a listener did not stop cleanly (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      await connection.stop();
    },
  };
}
