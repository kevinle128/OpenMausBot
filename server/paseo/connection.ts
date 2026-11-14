import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoAgent, PaseoAgentPermissionResponse } from "@getpaseo/client";
import {
  DaemonClient,
  type AgentAttentionRequiredNotification,
  type ConnectionState,
  type DaemonClientConfig,
  type FetchAgentsEntry,
} from "@getpaseo/client/internal/daemon-client";

export type PaseoPermissionRequest = PaseoAgent["pendingPermissions"][number];

export interface PaseoPermissionRequested {
  agentId: string;
  request: PaseoPermissionRequest;
  agent: PaseoAgent;
}

export interface PaseoPermissionResolved {
  agentId: string;
  requestId: string;
}

export interface PaseoConnectionEvents {
  connected: [];
  disconnected: [reason: string | undefined];
  agentUpdate: [agent: PaseoAgent];
  agentRemoved: [agentId: string];
  permissionRequested: [event: PaseoPermissionRequested];
  permissionResolved: [event: PaseoPermissionResolved];
  /** Every permission pending after a snapshot of the agents; `complete` is false while later pages are not watched. */
  permissionsSynced: [event: { pending: Array<{ agentId: string; requestId: string }>; complete: boolean }];
  attentionRequired: [notification: AgentAttentionRequiredNotification];
}

type AgentUpdateMessage = {
  type: string;
  payload?: { kind?: string; agent?: PaseoAgent; agentId?: string };
};

interface AgentSubscriptionObserver {
  snapshot(snapshot: { entries: FetchAgentsEntry[]; pageInfo: { hasMore: boolean } }): void;
  update(message: AgentUpdateMessage): void;
  error?(error: unknown): void;
}

/** The part of DaemonClient this module uses, so a test can stand in for the daemon. */
export interface PaseoClientPort {
  readonly authFailureReason: string | null;
  connect(): Promise<void>;
  close(): Promise<void>;
  subscribeConnectionStatus(listener: (status: ConnectionState) => void): () => void;
  observeAgents(options: { scope: "active"; includeBackground: boolean }): {
    ready: Promise<unknown>;
    subscribe(observer: AgentSubscriptionObserver): () => void;
    release(): Promise<void>;
  };
  onAgentAttentionRequired(handler: (notification: AgentAttentionRequiredNotification) => void): () => void;
  respondToPermission(agentId: string, requestId: string, response: PaseoPermissionResponse): Promise<void>;
}

export type PaseoPermissionResponse = PaseoAgentPermissionResponse;

export interface PaseoConnectionOptions {
  url?: string;
  paseoHome?: string;
  /** Replaced by tests. */
  createClient?: (config: DaemonClientConfig) => PaseoClientPort;
  /** Wait before the next fresh client after the daemon refused this one. */
  restartBackoffMs?: { base: number; max: number };
  log?: (message: string) => void;
}

export const DEFAULT_PASEO_URL = "ws://127.0.0.1:6767/ws";

export function paseoHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PASEO_HOME || join(homedir(), ".paseo");
}

/** The daemon rewrites this file on every start, so each connection attempt reads it again. */
export function readPaseoLocalCredential(paseoHome: string): string | undefined {
  try {
    const token = readFileSync(join(paseoHome, "local-credential"), "utf8").trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export class PaseoConnection extends EventEmitter<PaseoConnectionEvents> {
  private readonly options: Required<Pick<PaseoConnectionOptions, "url" | "paseoHome">> & PaseoConnectionOptions;
  private client: PaseoClientPort | null = null;
  private stopped = true;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private endSession: (() => void) | null = null;
  private readonly pending = new Map<string, Map<string, PaseoPermissionRequest>>();

  constructor(options: PaseoConnectionOptions = {}) {
    super();
    this.options = {
      ...options,
      url: options.url ?? DEFAULT_PASEO_URL,
      paseoHome: options.paseoHome ?? paseoHomeDir(),
    };
  }

  private isUp = false;

  get connected(): boolean {
    return this.isUp;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    this.endSession?.();
    const client = this.client;
    if (client) await client.close().catch(() => {});
    await this.loop;
    this.loop = null;
  }

  async respondToPermission(agentId: string, requestId: string, response: PaseoPermissionResponse): Promise<void> {
    const client = this.client;
    if (!client || !this.isUp) throw new Error("The Paseo daemon is not connected");
    await client.respondToPermission(agentId, requestId, response);
    this.settle(agentId, requestId);
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private createClient(): PaseoClientPort {
    const config: DaemonClientConfig = {
      url: this.options.url,
      clientId: `omb-paseo-bridge-${process.pid}`,
      clientType: "cli",
      localCredential: () => readPaseoLocalCredential(this.options.paseoHome),
      reconnect: { enabled: true, baseDelayMs: 1_000, maxDelayMs: 15_000 },
    };
    return this.options.createClient?.(config) ?? (new DaemonClient(config) as unknown as PaseoClientPort);
  }

  private async run(): Promise<void> {
    const backoff = this.options.restartBackoffMs ?? { base: 2_000, max: 30_000 };
    let delay = backoff.base;
    while (!this.stopped) {
      const client = this.createClient();
      this.client = client;
      try {
        const lasted = await this.session(client);
        if (lasted) delay = backoff.base;
      } catch (error) {
        this.log(`paseo bridge: connection failed: ${describe(error)}`);
      } finally {
        this.isUp = false;
        this.client = null;
        this.pending.clear();
        await client.close().catch(() => {});
      }
      if (this.stopped) break;
      await this.sleep(delay);
      delay = Math.min(delay * 2, backoff.max);
    }
  }

  /** Resolves true once connected and later lost for good; DaemonClient retries transient drops by itself. */
  private async session(client: PaseoClientPort): Promise<boolean> {
    let established = false;
    let finished: (() => void) | null = null;
    const done = new Promise<void>((resolve) => (finished = resolve));
    this.endSession = () => finished?.();
    const detachStatus = client.subscribeConnectionStatus((status) => {
      if (status.status === "connected") {
        this.isUp = true;
        this.log("paseo bridge: connected");
        this.emit("connected");
      } else if (status.status === "disconnected") {
        const wasUp = this.isUp;
        this.isUp = false;
        this.pending.clear();
        if (wasUp) this.emit("disconnected", status.reason);
        if (client.authFailureReason) finished?.();
      } else if (status.status === "disposed") {
        finished?.();
      }
    });
    const detachAttention = client.onAgentAttentionRequired((notification) => this.emit("attentionRequired", notification));
    try {
      await Promise.race([client.connect(), done]);
      if (this.stopped) return false;
      const subscription = client.observeAgents({ scope: "active", includeBackground: true });
      subscription.subscribe({
        snapshot: ({ entries, pageInfo }) => {
          if (pageInfo.hasMore) this.log("paseo bridge: more agents exist than the first page; later pages are not watched");
          this.pending.clear();
          for (const entry of entries) this.observe(entry.agent);
          this.emit("permissionsSynced", {
            pending: [...this.pending].flatMap(([agentId, requests]) => [...requests.keys()].map((requestId) => ({ agentId, requestId }))),
            complete: !pageInfo.hasMore,
          });
        },
        update: (message) => this.receive(message),
        error: (error) => this.log(`paseo bridge: agent subscription error: ${describe(error)}`),
      });
      await Promise.race([subscription.ready, done]);
      established = this.isUp;
      await done;
      return established;
    } finally {
      detachStatus();
      detachAttention();
      this.endSession = null;
    }
  }

  private receive(message: AgentUpdateMessage): void {
    if (message.type !== "agent_update" || !message.payload) return;
    if (message.payload.kind === "upsert" && message.payload.agent) this.observe(message.payload.agent);
    else if (message.payload.kind === "remove" && message.payload.agentId) {
      const agentId = message.payload.agentId;
      for (const requestId of Array.from(this.pending.get(agentId)?.keys() ?? [])) this.settle(agentId, requestId);
      this.pending.delete(agentId);
      this.emit("agentRemoved", agentId);
    }
  }

  private observe(agent: PaseoAgent): void {
    this.emit("agentUpdate", agent);
    const known = this.pending.get(agent.id) ?? new Map<string, PaseoPermissionRequest>();
    const current = new Map(agent.pendingPermissions.map((request) => [request.id, request]));
    for (const requestId of known.keys()) {
      if (!current.has(requestId)) {
        known.delete(requestId);
        this.emit("permissionResolved", { agentId: agent.id, requestId });
      }
    }
    for (const [requestId, request] of current) {
      if (known.has(requestId)) continue;
      known.set(requestId, request);
      this.emit("permissionRequested", { agentId: agent.id, request, agent });
    }
    if (known.size > 0) this.pending.set(agent.id, known);
    else this.pending.delete(agent.id);
  }

  private settle(agentId: string, requestId: string): void {
    const known = this.pending.get(agentId);
    if (!known?.delete(requestId)) return;
    if (known.size === 0) this.pending.delete(agentId);
    this.emit("permissionResolved", { agentId, requestId });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
