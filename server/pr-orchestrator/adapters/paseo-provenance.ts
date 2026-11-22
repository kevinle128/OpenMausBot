import { lastChangeRequestUrl } from "../../../shared/thread-link.ts";
import { PARENT_AGENT_LABEL } from "../../paseo/gatekeeper.ts";
import type { PaseoConnection, PaseoTimelineItem } from "../../paseo/connection.ts";
import { PortUnavailableError, type OwnerResolver } from "../ports.ts";
import type { Owner, Provider } from "../types.ts";
import type { AgentBook, AgentInfo } from "./agent-book.ts";
import { parsePrUrl, type ParsedPrUrl } from "./pr-url.ts";

export type Created = { pr: { provider: Provider; repo: string; number: number; url: string }; owner: Owner; at: number };

type Source = Pick<PaseoConnection, "on" | "off" | "timelineTail" | "connected">;

export const SCAN_DELAY_MS = 2_000;
export const BACKFILL_WINDOW_MS = 30 * 60 * 1000;
export const RESOLVE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RESOLVE_MAX_AGENTS = 30;
export const MISS_MEMORY_MS = 10 * 60 * 1000;
const REPORTED_MAX = 2_000;
const MAX_HOPS = 10;

const CREATE_COMMANDS = [/\bgh\s+pr\s+create\b/, /\bglab\s+mr\s+create\b/];
// The endpoint must end at the collection: `/pulls/42/reviews` or `/merge_requests/7/notes` creates no PR.
// Each API call is the rest of its own line, so the method and field flags of other commands in the script do not count.
const API_CALLS = [/\bgh\s+api\b[^\n]*\/pulls(?=$|[\s"'?])[^\n]*/gm, /\bglab\s+api\b[^\n]*\/merge_requests(?=$|[\s"'?])[^\n]*/gm];
// Flags are case-sensitive and start a word; only the method name is case-insensitive and may be quoted.
const POST_SIGNS = /\s(?:-X\s*["']?[Pp][Oo][Ss][Tt]\b|--method(?:=|\s+)["']?[Pp][Oo][Ss][Tt]\b|-[fF][\s=]|--(?:field|raw-field|input)[\s=])/;
const NON_POST_METHOD = /\s(?:-X\s*|--method(?:=|\s+))["']?(?![Pp][Oo][Ss][Tt]\b)[A-Za-z]+\b/;
const postsToCollection = (command: string): boolean =>
  API_CALLS.some(pattern => (command.match(pattern) ?? []).some(call => POST_SIGNS.test(call) && !NON_POST_METHOD.test(call)));
const CREATE_TOOL = /create_?(?:pull_request|merge_request)/i;

/** Every string in a tool detail, deep enough for an MCP result (`output.content[].text`). */
function stringsOf(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth >= 6 || typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(inner => stringsOf(inner, depth + 1));
}

/**
 * The URL that a successful create call printed, or null. A URL that only appears in a command's text is a mention, so only the
 * output (or a field of a create tool's result) is read. The item is untrusted data.
 */
export function createdUrl(item: PaseoTimelineItem): string | null {
  if (item.type !== "tool_call") return null;
  // A failed, canceled or still running call created nothing that can be trusted.
  if (item.status !== undefined && item.status !== "completed") return null;
  const detail = item.detail;
  if (!detail) return null;
  if (detail.type === "shell") {
    const { command, output, exitCode } = detail;
    if (typeof command !== "string" || typeof output !== "string") return null;
    const creates = CREATE_COMMANDS.some(pattern => pattern.test(command))
      || postsToCollection(command);
    if (!creates) return null;
    const url = lastChangeRequestUrl(output);
    if (exitCode === 0) return url;
    return (exitCode === undefined || exitCode === null) && url ? url : null;
  }
  if (typeof item.name !== "string" || !CREATE_TOOL.test(item.name)) return null;
  // The tool's own input can name another PR, so only what the tool returned is read.
  const { input: _input, ...result } = detail;
  return lastChangeRequestUrl(stringsOf(result).join("\n"));
}

export interface ProvenanceDeps {
  connection: Source;
  book: AgentBook;
  log(line: string): void;
  now(): number;
  gitlabHosts(): string[];
  /** False while owner binding is switched off: no timeline is read and no PR is marked as seen. Always on when absent. */
  enabled?(): boolean;
  /** Replaced by tests. */
  scanDelayMs?: number;
}

export function createProvenance(deps: ProvenanceDeps) {
  const { connection, book, log } = deps;
  const listeners = new Set<(created: Created) => void>();
  const reported = new Set<string>();
  const lastStatus = new Map<string, string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const misses = new Map<string, number>();
  let stopped = false;

  const parse = (url: string): ParsedPrUrl | null => parsePrUrl(url, deps.gitlabHosts());

  /** The owner is the highest agent of the parent chain that is still live; the top of the chain when none is. */
  function rootOf(agentId: string): AgentInfo | null {
    const path: AgentInfo[] = [];
    const seen = new Set<string>();
    let current = book.find(agentId);
    while (current && !seen.has(current.id) && path.length <= MAX_HOPS) {
      seen.add(current.id);
      path.push(current);
      const parent = current.labels[PARENT_AGENT_LABEL];
      current = parent ? book.find(parent) : undefined;
    }
    if (path.length === 0) return null;
    for (let at = path.length - 1; at >= 0; at -= 1) if (book.isLive(path[at]!.id)) return path[at]!;
    return path.at(-1)!;
  }

  const ownerOf = (root: AgentInfo, boundBy: Owner["boundBy"]): Owner => ({
    runtime: "paseo", hostId: "local", agentId: root.id, workspaceId: root.workspaceId, projectId: null,
    harness: root.provider, model: root.model, cwd: root.cwd, boundBy, boundAt: deps.now(),
  });

  const firstSeen = (key: string): boolean => {
    if (reported.has(key)) return false;
    if (reported.size >= REPORTED_MAX) reported.delete(reported.values().next().value as string);
    reported.add(key);
    return true;
  };

  async function scan(agentId: string, boundBy: "provenance" | "backfill"): Promise<void> {
    if (stopped || listeners.size === 0 || deps.enabled?.() === false) return;
    let items: PaseoTimelineItem[];
    try {
      items = await connection.timelineTail(agentId, 100);
    } catch (error) {
      log(`pr-orchestrator: the timeline of agent ${agentId} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // Binding may have been switched off or the last watcher gone while the timeline was read: mark nothing as seen.
    if (stopped || listeners.size === 0 || deps.enabled?.() === false) return;
    for (const item of items) {
      const url = createdUrl(item);
      const pr = url ? parse(url) : null;
      if (!pr || !firstSeen(`${agentId}\n${pr.url}`)) continue;
      const root = rootOf(agentId);
      if (!root) continue;
      const created: Created = { pr: { provider: pr.provider, repo: pr.repo, number: pr.number, url: pr.url }, owner: ownerOf(root, boundBy), at: deps.now() };
      log(`pr-orchestrator: agent ${agentId} opened ${pr.url}; owner is agent ${root.id}`);
      for (const listener of listeners) listener(created);
    }
  }

  const scanSoon = (agentId: string) => {
    if (timers.has(agentId) || stopped) return;
    const timer = setTimeout(() => { timers.delete(agentId); void scan(agentId, "provenance"); }, deps.scanDelayMs ?? SCAN_DELAY_MS);
    timer.unref?.();
    timers.set(agentId, timer);
  };

  const onUpdate = (agent: unknown) => {
    const id = (agent as { id?: unknown } | null)?.id;
    const status = (agent as { status?: unknown } | null)?.status;
    if (typeof id !== "string" || typeof status !== "string") return;
    const before = lastStatus.get(id);
    lastStatus.set(id, status);
    if (before === "running" && status !== "running") scanSoon(id);
  };
  const onRemoved = (agentId: string) => {
    lastStatus.delete(agentId);
    const timer = timers.get(agentId);
    if (timer) { clearTimeout(timer); timers.delete(agentId); }
    void scan(agentId, "provenance");
  };
  const backfill = () => {
    const since = deps.now() - BACKFILL_WINDOW_MS;
    void (async () => {
      for (const { info, changedAt } of book.all()) if (changedAt >= since) await scan(info.id, "backfill");
    })();
  };
  const onSynced = ({ complete }: { complete: boolean }) => {
    if (complete) backfill();
  };
  const onDisconnected = () => lastStatus.clear();
  connection.on("agentUpdate", onUpdate as never);
  connection.on("agentRemoved", onRemoved);
  connection.on("permissionsSynced", onSynced as never);
  connection.on("disconnected", onDisconnected as never);

  const resolver: OwnerResolver = {
    name: "paseo-timeline",
    async resolve(pr) {
      if (pr.url === null) return "next";
      const target = parse(pr.url);
      if (!target) return "next";
      const now = deps.now();
      const missedAt = misses.get(target.url);
      if (missedAt !== undefined && now - missedAt < MISS_MEMORY_MS) return "next";
      if (!connection.connected || !book.synced) throw new PortUnavailableError("the Paseo daemon is not connected or has not listed its agents yet");
      const candidates = book.all()
        .filter(entry => now - entry.changedAt <= RESOLVE_WINDOW_MS)
        .sort((a, b) => b.changedAt - a.changedAt)
        .slice(0, RESOLVE_MAX_AGENTS);
      for (const { info } of candidates) {
        let items: PaseoTimelineItem[];
        try {
          items = await connection.timelineTail(info.id, 200);
        } catch (error) {
          // A daemon that went away mid-scan says nothing about the PR: wait for it instead of remembering a miss.
          if (!connection.connected || !book.synced || /not connected/i.test(error instanceof Error ? error.message : "")) {
            throw new PortUnavailableError("the Paseo daemon is not connected or has not listed its agents yet");
          }
          continue;
        }
        const found = items.some(item => {
          const url = createdUrl(item);
          return url !== null && parse(url)?.url === target.url;
        });
        const root = found ? rootOf(info.id) : null;
        if (root) return ownerOf(root, "backfill");
      }
      misses.set(target.url, now);
      if (misses.size > REPORTED_MAX) misses.delete(misses.keys().next().value as string);
      return "next";
    },
  };

  return {
    resolver,
    watch(listener: (created: Created) => void): () => void {
      const first = listeners.size === 0;
      listeners.add(listener);
      // The connect snapshot may have come before anyone watched; scan what changed lately now.
      if (first && book.synced && connection.connected) backfill();
      return () => { listeners.delete(listener); };
    },
    stop(): void {
      stopped = true;
      connection.off("agentUpdate", onUpdate as never);
      connection.off("agentRemoved", onRemoved);
      connection.off("permissionsSynced", onSynced as never);
      connection.off("disconnected", onDisconnected as never);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      listeners.clear();
    },
  };
}
