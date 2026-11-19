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
  connection.on("agentUpdate", onUpdate as never);
  connection.on("agentRemoved", onRemoved);
  return {
    get: (id: string): LiveAgent | undefined => agents.get(id),
    all: (): LiveAgent[] => [...agents.values()],
    stop(): void {
      connection.off("agentUpdate", onUpdate as never);
      connection.off("agentRemoved", onRemoved);
      agents.clear();
    },
  };
}

export type LiveAgents = ReturnType<typeof createLiveAgents>;

export function agentTitle(agent: Pick<LiveAgent, "id" | "title">): string {
  return agent.title?.trim() || agent.id.slice(0, 8);
}
