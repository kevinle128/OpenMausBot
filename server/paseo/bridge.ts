import { PaseoConnection } from "./connection.ts";
import { startPaseoGatekeeper, type PaseoGatekeeperDeps } from "./gatekeeper.ts";

export type PaseoBridgeWiring = Omit<PaseoGatekeeperDeps, "connection" | "log">;

/**
 * The worker that keeps one connection to the Paseo daemon. It is off unless OMB_PASEO_BRIDGE=1, and a daemon that is
 * down or refuses the credential only delays it: the connection retries with a growing wait and never stops OMB.
 * With `wiring`, the permissions its agents ask for are decided as they arrive.
 */
export function startPaseoBridge(env: NodeJS.ProcessEnv = process.env, wiring?: PaseoBridgeWiring): PaseoConnection | null {
  if (env.OMB_PASEO_BRIDGE !== "1") return null;
  const log = (message: string) => console.log(message);
  const connection = new PaseoConnection({
    ...(env.OMB_PASEO_URL ? { url: env.OMB_PASEO_URL } : {}),
    log,
  });
  connection.on("error", (error) => console.error("paseo bridge: listener failed", error));
  if (wiring) startPaseoGatekeeper({ ...wiring, connection, log });
  connection.start();
  return connection;
}
