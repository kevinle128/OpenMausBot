// Event connectors (GitHub Event, GitLab Event, ...) as the admin API lists them: apps that receive events, never tools for a bot.
import { useCallback, useEffect, useState } from "react";
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
export function useEventConnectors(watching: boolean) {
  const [connectors, setConnectors] = useState<EventConnector[] | null>(null);
  const refresh = useCallback(async () => {
    try {
      setConnectors(await loadEventConnectors());
    } catch {
      setConnectors((current) => current);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!watching) return;
    void refresh();
    const timer = setInterval(() => void refresh(), EVENT_CONNECTOR_REFRESH_MS);
    return () => clearInterval(timer);
  }, [watching, refresh]);
  const replace = useCallback((updated: EventConnector) => {
    setConnectors((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current);
  }, []);
  return { connectors, refresh, replace };
}
