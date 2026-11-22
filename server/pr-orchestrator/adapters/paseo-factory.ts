import type { PaseoConnection } from "../../paseo/connection.ts";
import type { AgentRuntimePort, OwnerResolver } from "../ports.ts";
import type { AdapterContext } from "./build.ts";
import { createPaseoRuntime } from "./paseo-runtime.ts";

/** The Paseo runtime with its owner resolvers, or null while this install has no Paseo connection. */
export function paseoRuntime(connection: PaseoConnection | null, ctx: AdapterContext): { runtime: AgentRuntimePort; resolvers: OwnerResolver[]; stop(): void } | null {
  if (!connection) return null;
  const runtime = createPaseoRuntime({
    connection, log: ctx.log, now: ctx.now,
    gitlabHosts: () => [new URL(ctx.config().adapters.forge.gitlab.baseUrl).host],
  });
  return { runtime, resolvers: [runtime.resolver], stop: () => runtime.stop() };
}
