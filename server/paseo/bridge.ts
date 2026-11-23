import { createApprovalNotifier } from "./approval-notice.ts";
import { PaseoConnection } from "./connection.ts";
import { startDispatcherWake, type DispatcherWakeDeps } from "./dispatcher-wake.ts";
import { startPaseoGatekeeper, type PaseoGatekeeperDeps } from "./gatekeeper.ts";
import { createLiveAgents } from "./live-agents.ts";
import type { SecretsService } from "../secrets/service.ts";

export type PaseoBridgeWiring = Omit<PaseoGatekeeperDeps, "connection" | "log" | "agentContext"> & {
  /** With this, a Paseo agent a Dispatcher bot created wakes that bot's thread when it finishes or fails. */
  dispatcher?: Pick<DispatcherWakeDeps, "store" | "wake">;
  /** With this, the agents the daemon lists name a secret request on its card, and an approved request is told to its agent. */
  secrets?: Pick<SecretsService, "attach">;
};

export interface PaseoBridge {
  connection: PaseoConnection;
  /** Stops the gatekeeper and the Dispatcher wake, then closes the connection to the daemon. */
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
    const { dispatcher, secrets, ...gatekeeper } = wiring;
    const agents = createLiveAgents(connection);
    stops.push(() => agents.stop());
    const notifier = createApprovalNotifier({ connection, agents, log });
    stops.push(() => notifier.stop());
    if (secrets) stops.push(secrets.attach({ agents, notifier }));
    stops.push(startPaseoGatekeeper({ ...gatekeeper, connection, log, agentContext: (agentId) => connection.agentContext(agentId) }));
    if (dispatcher) stops.push(startDispatcherWake({ ...dispatcher, connection, log }));
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
