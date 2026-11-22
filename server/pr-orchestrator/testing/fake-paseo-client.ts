import { PaseoConnection, type PaseoClientPort, type PaseoCreateAgentOptions } from "../../paseo/connection.ts";

type Status = Parameters<Parameters<PaseoClientPort["subscribeConnectionStatus"]>[0]>[0];
type Observer = Parameters<ReturnType<PaseoClientPort["observeAgents"]>["subscribe"]>[0];
type Timeline = NonNullable<Awaited<ReturnType<NonNullable<PaseoClientPort["fetchAgentTimeline"]>>>["entries"]>[number]["item"];

export interface SentMessage { agentId: string; text: string; options: Record<string, unknown> | undefined }

/** A scripted Paseo daemon: it records every call and answers from what a test sets. No call leaves the process. */
export class FakePaseoClient implements PaseoClientPort {
  authFailureReason: string | null = null;
  observer: Observer | null = null;
  sent: SentMessage[] = [];
  created: PaseoCreateAgentOptions[] = [];
  labelled: Array<{ agentId: string; labels: Record<string, string> }> = [];
  timelines: Record<string, Timeline[]> = {};
  /** Makes the next sendAgentMessage fail with this error. */
  sendError: Error | null = null;
  /** The daemon takes the next message, then the connection breaks before the answer arrives. */
  failAfterAccept = false;
  /** How many times the daemon was asked for a timeline. */
  timelineReads = 0;
  /** A message id that the daemon already holds, as its receipts do: the same text again does nothing, other text is refused. */
  repeats = 0;
  private readonly receipts = new Map<string, string>();
  /** The agent that createAgent returns, by idempotency key. */
  private readonly made = new Map<string, unknown>();
  private listener: ((status: Status) => void) | null = null;

  async connect() { this.listener?.({ status: "connected" }); }
  async close() {}
  subscribeConnectionStatus(listener: (status: Status) => void) { this.listener = listener; return () => {}; }
  observeAgents() {
    return { ready: Promise.resolve({}), subscribe: (observer: Observer) => { this.observer = observer; return () => {}; }, release: async () => {} };
  }
  onAgentAttentionRequired() { return () => {}; }
  async respondToPermission() {}
  async sendAgentMessage(agentId: string, text: string, options?: Record<string, unknown>) {
    if (this.sendError) throw this.sendError;
    const messageId = typeof options?.messageId === "string" ? options.messageId : null;
    if (messageId !== null) {
      const held = this.receipts.get(`${agentId}/${messageId}`);
      if (held !== undefined) {
        if (held !== text) throw new Error("agent_request_key_conflict");
        this.repeats += 1;
        return;
      }
      this.receipts.set(`${agentId}/${messageId}`, text);
    }
    this.sent.push({ agentId, text, options });
    if (this.failAfterAccept) {
      this.failAfterAccept = false;
      throw new Error("socket reset");
    }
  }
  async updateAgent(agentId: string, updates: { labels?: Record<string, string> }) { this.labelled.push({ agentId, labels: updates.labels ?? {} }); }
  async createAgent(options: PaseoCreateAgentOptions) {
    this.created.push(options);
    if (!this.made.has(options.idempotencyKey)) {
      this.made.set(options.idempotencyKey, { id: `new-${this.made.size + 1}`, provider: options.provider, model: options.model ?? "default", cwd: options.cwd, workspaceId: options.workspaceId ?? "ws-new", status: "running", labels: options.labels, archivedAt: null, pendingPermissions: [] });
    }
    return this.made.get(options.idempotencyKey) as never;
  }
  async fetchAgentTimeline(agentId: string) {
    this.timelineReads += 1;
    return { entries: (this.timelines[agentId] ?? []).map(item => ({ item })) }; }

  /** The daemon lists these agents (a complete snapshot). */
  snapshot(agents: Array<Record<string, unknown>>) {
    this.observer?.snapshot({ entries: agents.map(agent => ({ agent: { pendingPermissions: [], labels: {}, archivedAt: null, ...agent } }) as never), pageInfo: { hasMore: false } });
  }
  update(agent: Record<string, unknown>) {
    this.observer?.update({ type: "agent_update", payload: { kind: "upsert", agent: { pendingPermissions: [], labels: {}, archivedAt: null, ...agent } as never } });
  }
  remove(agentId: string) { this.observer?.update({ type: "agent_update", payload: { kind: "remove", agentId } }); }
  lose() { this.listener?.({ status: "disconnected", reason: "lost" }); }
  regain() { this.listener?.({ status: "connected" }); }
}

/** A started connection over a fake daemon. */
export async function connectedFake(client = new FakePaseoClient()): Promise<{ client: FakePaseoClient; connection: PaseoConnection }> {
  const connection = new PaseoConnection({ createClient: () => client, restartBackoffMs: { base: 1, max: 2 } });
  connection.start();
  await new Promise(resolve => setTimeout(resolve, 5));
  return { client, connection };
}

export const agentSnapshot = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, provider: "claude", model: "opus", cwd: `/work/${id}`, workspaceId: `ws-${id}`, status: "idle", updatedAt: new Date().toISOString(), ...over });
