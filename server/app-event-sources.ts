// GitHub Event and GitLab Event as app-automation sources. Composio stays the other source.
import type { AppEventCatalog, AppEventType, AppTriggerFilter } from "../shared/app-triggers.ts";
import { matchesFilter } from "./app-events.ts";
import type { PrStatusForBot } from "./pr-orchestrator/bot-status.ts";
import { BUILT_IN_CONNECTORS } from "./pr-orchestrator/connectors/index.ts";
import { CONTRACT_EVENT_TYPES } from "./pr-orchestrator/contract/omb-event.v1.ts";
import { anyGlob } from "./pr-orchestrator/glob.ts";
import { parseOrchestratorConfig } from "./pr-orchestrator/config.ts";
import type { LedgerEventForBot } from "./pr-orchestrator/core.ts";
import { prKey, type PrKey } from "./pr-orchestrator/types.ts";

export const EVENT_SOURCE_EVENT = "pull_request";
export const EVENT_SOURCE_EVENT_NAME = "Pull request activity";
export const HELD_EVENT_LIMIT = 50;
export const HELD_EVENT_MS = 6 * 60 * 60 * 1000;

const EVENT_SOURCE_USE = new Set(["github-event", "gitlab-event"]);
const PR_EVENT_TYPES = Object.entries(CONTRACT_EVENT_TYPES)
  .filter(([, meta]) => meta.domain === "pr")
  .map(([type]) => type);

export interface EventSourceInstance {
  id: string;
  title: string;
  enabled: boolean;
}

export interface HeldEvent {
  seq: number;
  id: string;
  at: number;
}

/** Ledger reads the app-trigger pump uses. */
export interface EventSourceFeed {
  eventsAfter(seq: number, limit: number): LedgerEventForBot[];
  latestEvents(limit: number): LedgerEventForBot[];
  prStatus(prKey: PrKey): PrStatusForBot | null;
  headSeq(): number;
}

export function isEventSourceApp(app: string): boolean {
  return EVENT_SOURCE_USE.has(app);
}

export function eventSourceTitle(app: string): string {
  return BUILT_IN_CONNECTORS.find((definition) => definition.id === app)?.title ?? app;
}

/** Enabled instances become apps. A switched-off instance is not connected, so the editor can offer setup. */
export function eventSourceInstances(text: string | null): EventSourceInstance[] {
  const parsed = parseOrchestratorConfig(text?.trim() ? text : "{}", BUILT_IN_CONNECTORS);
  const document = parsed.ok ? parsed.config : null;
  if (!document) return [];
  const found: EventSourceInstance[] = [];
  for (const [id, instance] of Object.entries(document.connectors)) {
    if (!EVENT_SOURCE_USE.has(instance.use)) continue;
    const definition = BUILT_IN_CONNECTORS.find((candidate) => candidate.id === instance.use);
    found.push({ id, title: definition?.title ?? id, enabled: instance.enabled });
  }
  return found;
}

export function eventSourceCatalog(
  instances: readonly EventSourceInstance[],
  opts: { app?: string; search?: string } = {},
): Pick<AppEventCatalog, "apps" | "notConnected"> {
  const wanted = opts.app?.trim().toLowerCase();
  const words = opts.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const event = sourceEventType();
  const visible = words.every((word) => `${event.name} ${event.description} ${event.event}`.toLowerCase().includes(word));
  const apps: AppEventCatalog["apps"] = [];
  const notConnected: AppEventCatalog["notConnected"] = [];
  for (const instance of instances) {
    if (wanted && instance.id !== wanted) continue;
    if (!instance.enabled) {
      notConnected.push({ app: instance.id, name: instance.title });
      continue;
    }
    apps.push({
      app: instance.id,
      name: instance.title,
      accounts: [{ id: instance.id }],
      events: visible ? [event] : [],
    });
  }
  return { apps, notConnected };
}

export function sourceEventType(): AppEventType {
  return {
    event: EVENT_SOURCE_EVENT,
    name: EVENT_SOURCE_EVENT_NAME,
    description: "Pull request activity on the repos this automation watches.",
    delivery: "instant",
    configFields: [
      {
        name: "types",
        type: "string",
        required: true,
        description: "Pull request event types. Separate them with commas or new lines.",
        options: PR_EVENT_TYPES,
      },
      {
        name: "repos",
        type: "string",
        required: true,
        description: "Repository globs. Separate them with commas or new lines. At least one.",
      },
      {
        name: "authors",
        type: "string",
        required: false,
        description: "Authors. Leave this empty to match every author.",
      },
    ],
    filterFields: [],
  };
}

export type NormalizedEventSourceConfig = { types: string[]; repos: string[]; authors: string[] };

/** Splits comma- and line-separated settings. Needs one known type and one repo glob. */
export function normalizeEventSourceConfig(config: Record<string, unknown> | undefined): { ok: true; config: NormalizedEventSourceConfig } | { ok: false; message: string } {
  const raw = config ?? {};
  const unknown = Object.keys(raw).filter((key) => key !== "types" && key !== "repos" && key !== "authors");
  if (unknown.length) return { ok: false, message: `This automation has no setting ${unknown.join(", ")}. Its settings are: types, repos, authors.` };
  const types = splitSetting(raw.types);
  const repos = splitSetting(raw.repos);
  const authors = splitSetting(raw.authors);
  if (!types.length) return { ok: false, message: "Choose at least one event type." };
  const known = new Set<string>(PR_EVENT_TYPES);
  const bad = types.filter((type) => !known.has(type));
  if (bad.length) return { ok: false, message: `${bad.join(", ")} is not a pull request event type.` };
  if (!repos.length) return { ok: false, message: "Choose at least one repo." };
  return { ok: true, config: { types, repos, authors } };
}

/** `from` and `subject` read top-level fields, and this event is nested, so they never match. */
export function eventSourceFilterError(filter: AppTriggerFilter | undefined, appName: string): string | null {
  if (filter?.from || filter?.subject) return `${appName} matches words in the event, not from or subject.`;
  return null;
}

export type SourceMatch = "yes" | "no" | "early";

export function matchEventSource(input: {
  app: string;
  config: Record<string, unknown>;
  filter?: AppTriggerFilter;
  createdAt: number;
  connector: string;
  event: LedgerEventForBot["event"];
  receivedAt: number;
  live: boolean;
  data: Record<string, unknown>;
}): SourceMatch {
  if (input.connector !== input.app) return "no";
  if (input.live && input.receivedAt < input.createdAt) return "early";
  const types = stringList(input.config.types);
  const repos = stringList(input.config.repos);
  const authors = stringList(input.config.authors);
  const subject = input.event.subject;
  const repo = subject.kind === "pr" && "repo" in subject ? subject.repo : "";
  const author = authorOf(input.event, input.data);
  if (!types.includes(input.event.type)) return "no";
  if (!repo || !anyGlob(repos, repo)) return "no";
  if (authors.length && !authors.some((name) => name.toLowerCase() === author.toLowerCase())) return "no";
  if (!matchesFilter(input.app, input.filter, input.data)) return "no";
  return "yes";
}

export function prKeyOfEvent(event: LedgerEventForBot["event"]): PrKey | null {
  const subject = event.subject;
  if (subject.kind === "pr" && "forge" in subject) return prKey(subject.forge, subject.repo, subject.number);
  return null;
}

/** The run block gets the ledger event and the PR status. Both are untrusted event data. */
export function sourceEventData(event: LedgerEventForBot["event"], pr: PrStatusForBot | null): Record<string, unknown> {
  return { event, pr };
}

export function eventBySeq(feed: EventSourceFeed, seq: number): LedgerEventForBot | null {
  const [next] = feed.eventsAfter(seq - 1, 1);
  return next?.seq === seq ? next : null;
}

export function parkHeld(held: readonly HeldEvent[], entry: HeldEvent): { held: HeldEvent[]; dropped: HeldEvent[] } {
  if (held.some((item) => item.id === entry.id)) return { held: [...held], dropped: [] };
  const next = [...held];
  const dropped: HeldEvent[] = [];
  while (next.length >= HELD_EVENT_LIMIT) {
    const oldest = next.shift();
    if (oldest) dropped.push(oldest);
  }
  next.push(entry);
  return { held: next, dropped };
}

export function splitExpired(held: readonly HeldEvent[], now: number): { keep: HeldEvent[]; dropped: HeldEvent[] } {
  const dropped = held.filter((item) => now - item.at >= HELD_EVENT_MS);
  return { keep: held.filter((item) => now - item.at < HELD_EVENT_MS), dropped };
}

function splitSetting(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => typeof item === "string" ? splitSetting(item) : []))];
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/[\n,]/).map((part) => part.trim()).filter(Boolean))];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

/** The event names the author or leaves it null; the ledger status then still knows the author of the PR. */
function authorOf(event: LedgerEventForBot["event"], data: Record<string, unknown>): string {
  const own = (event.data as { author?: unknown }).author;
  if (typeof own === "string" && own.trim()) return own.trim();
  const known = (data.pr as { author?: unknown } | null | undefined)?.author;
  return typeof known === "string" ? known.trim() : "";
}
