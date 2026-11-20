import type { PaseoConnection } from "./connection.ts";

export interface LiveAgent {
  id: string;
  status: string;
  updatedAt?: string | number | Date;
  title?: string | null;
  cwd?: string;
}

type Port = Pick<PaseoConnection, "on" | "off">;

/** The Paseo agents the daemon lists right now, kept from its update and remove events. */
export function createLiveAgents(connection: Port) {
  const agents = new Map<string, LiveAgent>();
  const onUpdate = (agent: LiveAgent) => {
    agents.set(agent.id, agent);
  };
  const onRemoved = (agentId: string) => {
    agents.delete(agentId);
  };
  // The daemon sends no removal for an agent that ended while it was away: what it lists after reconnecting starts afresh.
  const onDisconnected = () => {
    agents.clear();
  };
  connection.on("agentUpdate", onUpdate as never);
  connection.on("agentRemoved", onRemoved);
  connection.on("disconnected", onDisconnected as never);
  return {
    get: (id: string): LiveAgent | undefined => agents.get(id),
    all: (): LiveAgent[] => [...agents.values()],
    stop(): void {
      connection.off("agentUpdate", onUpdate as never);
      connection.off("agentRemoved", onRemoved);
      connection.off("disconnected", onDisconnected as never);
      agents.clear();
    },
  };
}

export type LiveAgents = ReturnType<typeof createLiveAgents>;

export function agentTitle(agent: Pick<LiveAgent, "id" | "title">): string {
  return agent.title?.trim() || agent.id.slice(0, 8);
}
