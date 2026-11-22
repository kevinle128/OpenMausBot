import type { PaseoConnection } from "../../paseo/connection.ts";
import { PortUnavailableError, type AgentRuntimePort, type OwnerResolver } from "../ports.ts";
import type { Owner } from "../types.ts";
import { agentInfoOf, createAgentBook, type AgentInfo } from "./agent-book.ts";
import { createProvenance } from "./paseo-provenance.ts";

type Connection = Pick<PaseoConnection,
  "on" | "off" | "connected" | "sendAgentMessageAsUser" | "setAgentLabels" | "createAgent" | "timelineTail">;

export interface PaseoRuntimeDeps {
  connection: Connection;
  log(line: string): void;
  now(): number;
  gitlabHosts(): string[];
  /** Replaced by tests. */
  scanDelayMs?: number;
}

/** The daemon already holds this message id (a repeat), or may hold it (an unknown outcome): sending again could only duplicate. */
const HELD = /agent_request_key_conflict|agent_request_outcome_unknown/;
const NOT_CONNECTED = /not connected/i;

const gone = (info: AgentInfo | undefined): boolean => !info || info.archivedAt !== null || info.status === "closed";

export function createPaseoRuntime(deps: PaseoRuntimeDeps): AgentRuntimePort & { resolver: OwnerResolver; stop(): void } {
  const { connection } = deps;
  const book = createAgentBook(connection, deps.now);
  const provenance = createProvenance({ connection, book, log: deps.log, now: deps.now, gitlabHosts: deps.gitlabHosts, scanDelayMs: deps.scanDelayMs });

  return {
    runtime: "paseo",
    resolver: provenance.resolver,
    watchCreations: listener => provenance.watch(listener),

    async send(owner, message, { messageId }) {
      if (owner.runtime !== "paseo") return "gone";
      if (!connection.connected || !book.synced) throw new PortUnavailableError("the Paseo daemon is not connected or has not listed its agents yet");
      if (gone(book.live(owner.agentId))) return "gone";
      try {
        await connection.sendAgentMessageAsUser(owner.agentId, message, { messageId });
        return "delivered";
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (HELD.test(text)) return "delivered";
        if (NOT_CONNECTED.test(text)) throw new PortUnavailableError("the Paseo daemon is not connected");
        throw error;
      }
    },

    async isAlive(owner) {
      return owner.runtime === "paseo" && !gone(book.live(owner.agentId));
    },

    async spawn(req) {
      if (!connection.connected) throw new PortUnavailableError("the Paseo daemon is not connected");
      let created: unknown;
      try {
        created = await connection.createAgent({
          provider: req.harness, cwd: req.cwd, ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}), ...(req.model ? { model: req.model } : {}),
          initialPrompt: req.brief, labels: req.labels, idempotencyKey: req.requestId,
        });
      } catch (error) {
        if (NOT_CONNECTED.test(error instanceof Error ? error.message : "")) throw new PortUnavailableError("the Paseo daemon is not connected");
        throw error;
      }
      const info = agentInfoOf(created, deps.now());
      if (!info) throw new Error("the Paseo daemon returned an agent without an id");
      const owner: Owner = {
        runtime: "paseo", hostId: "local", agentId: info.id, workspaceId: info.workspaceId ?? req.workspaceId, projectId: null,
        harness: info.provider ?? req.harness, model: info.model ?? req.model, cwd: info.cwd ?? req.cwd, boundBy: "claim", boundAt: deps.now(),
      };
      return owner;
    },

    async label(owner, key, value) {
      try {
        await connection.setAgentLabels(owner.agentId, { [key]: value });
      } catch (error) {
        if (NOT_CONNECTED.test(error instanceof Error ? error.message : "")) throw new PortUnavailableError("the Paseo daemon is not connected");
        throw error;
      }
    },

    stop() {
      provenance.stop();
      book.stop();
    },
  };
}
