import { PaseoConnection } from "./connection.ts";

/**
 * The worker that keeps one connection to the Paseo daemon. It is off unless OMB_PASEO_BRIDGE=1, and a daemon that is
 * down or refuses the credential only delays it: the connection retries with a growing wait and never stops OMB.
 */
export function startPaseoBridge(env: NodeJS.ProcessEnv = process.env): PaseoConnection | null {
  if (env.OMB_PASEO_BRIDGE !== "1") return null;
  const connection = new PaseoConnection({
    ...(env.OMB_PASEO_URL ? { url: env.OMB_PASEO_URL } : {}),
    log: (message) => console.log(message),
  });
  connection.on("error", (error) => console.error("paseo bridge: listener failed", error));
  connection.start();
  return connection;
}
