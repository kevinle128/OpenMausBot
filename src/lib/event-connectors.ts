// Event connectors (GitHub Event, GitLab Event, ...) as the admin API lists them: apps that receive events, never tools for a bot.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";

export interface EventConnectorType {
  type: string;
  title: string;
  description: string;
  payloadSchema: Record<string, unknown>;
}

export interface EventConnectorRoutine {
  routineId: string;
  name: string;
  active: boolean;
  describe: string;
}

export interface EventConnector {
  id: string;
  /** The connector definition this instance runs (`github-event`, `gitlab-event`, ...). */
  use?: string;
  title: string;
  description: string;
  icon: { glyph: string } | { image: string };
  delivery: string;
  enabled: boolean;
  intakePath: string | null;
  intakeUrl: string | null;
  /** The Vault name of the secret. The value never leaves the server. */
  secretName: string | null;
  secretPresent: boolean;
  settings: Record<string, unknown>;
  settingsSchema: Record<string, unknown>;
  eventTypes: EventConnectorType[];
  status: { lastEventAt: number | null; events24h: number; lastError: string | null; lastErrorAt: number | null; signatureFailures24h: number };
  usedBy: EventConnectorRoutine[];
}

export interface EventConnectorPatch {
  enabled?: boolean;
  settings?: Record<string, unknown>;
  secretName?: string;
  /** Write-only connector secret; empty string removes the saved secret. */
  secret?: string;
}

export const EVENT_CONNECTORS_CATEGORY = "Developer tools";

export function eventConnectorConnected(connector: Pick<EventConnector, "enabled" | "secretPresent">): boolean {
  return connector.enabled && connector.secretPresent;
}

export function eventConnectorMatchesSearch(connector: Pick<EventConnector, "id" | "title" | "description">, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  const hay = `${connector.title} ${connector.id} ${connector.description} developer tools pull request pr event`.toLowerCase();
  return query.split(/\s+/).every((part) => hay.includes(part));
}

const PATH = "/api/pr-orchestrator/connectors";
export const EVENT_CONNECTOR_REFRESH_MS = 30_000;

export async function loadEventConnectors(): Promise<EventConnector[]> {
  const body = await api<{ connectors?: EventConnector[] }>(PATH);
  return body.connectors ?? [];
}

/** Saves one change and returns the connector as the server now has it. A refused change throws the server's message. */
export function saveEventConnector(id: string, patch: EventConnectorPatch): Promise<EventConnector> {
  return api<EventConnector>(`${PATH}/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(patch) });
}

/**
 * The connectors, loaded once and again every 30 s while `watching` is true (the detail is open).
 * `null` means "not shown": the list is not loaded yet, or this person may not see it (it needs the admin scope).
 */
export function useEventConnectors(watching: boolean, refreshKey = 0) {
  const [connectors, setConnectors] = useState<EventConnector[] | null>(null);
  // Bumped by every load and every saved change, so a load that started before a newer one does not overwrite it.
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const started = ++generation.current;
    try {
      const loaded = await loadEventConnectors();
      if (generation.current === started) setConnectors(loaded);
    } catch {
      setConnectors((current) => current);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);
  useEffect(() => {
    if (!watching) return;
    void refresh();
    const timer = setInterval(() => void refresh(), EVENT_CONNECTOR_REFRESH_MS);
    return () => clearInterval(timer);
  }, [watching, refresh]);
  const replace = useCallback((updated: EventConnector) => {
    generation.current++;
    setConnectors((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current);
  }, []);
  return { connectors, refresh, replace };
}
