import type { PaseoConnection } from "../../paseo/connection.ts";
import type { AgentRuntimePort, OwnerResolver } from "../ports.ts";
import type { AdapterContext } from "./build.ts";

/** The Paseo runtime with its owner resolvers, or null while this install has none. */
export function paseoRuntime(_connection: PaseoConnection | null, _ctx: AdapterContext): { runtime: AgentRuntimePort; resolvers: OwnerResolver[]; stop(): void } | null {
  return null;
}
