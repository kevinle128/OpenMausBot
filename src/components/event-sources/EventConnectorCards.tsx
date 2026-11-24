import { useEffect, useState } from "react";
import {
  EVENT_CONNECTORS_CATEGORY,
  eventConnectorConnected,
  eventConnectorMatchesSearch,
  saveEventConnector,
  useEventConnectors,
  type EventConnectorPatch,
} from "@/lib/event-connectors";
import { EventConnectorTile } from "./EventConnectorTile";

/** Event connector app tiles rendered inline inside the standard Apps grid under Developer tools. */
export function EventConnectorCards({ filter, category, search, refreshKey = 0, onCount }: {
  filter: "all" | "connected" | "mcp";
  category: string | null;
  search: string;
  refreshKey?: number;
  onCount?: (connected: number, shown: number) => void;
}) {
  const { connectors, replace } = useEventConnectors(false, refreshKey);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const searching = search.trim().length > 0;
  const visible = (connectors ?? []).filter((connector) => {
    if (filter === "mcp") return false;
    if (!searching && category !== null && category !== EVENT_CONNECTORS_CATEGORY) return false;
    if (!searching && filter === "connected" && !eventConnectorConnected(connector)) return false;
    return eventConnectorMatchesSearch(connector, search);
  });
  const connectedCount = (connectors ?? []).filter(eventConnectorConnected).length;

  useEffect(() => {
    onCount?.(connectedCount, visible.length);
  }, [connectedCount, visible.length, onCount]);

  if (visible.length === 0) return null;

  const run = (id: string, patch: EventConnectorPatch) => {
    setBusyId(id);
    setErrors((current) => ({ ...current, [id]: null }));
    saveEventConnector(id, patch)
      .then((updated) => replace(updated))
      .catch((failure) => setErrors((current) => ({ ...current, [id]: failure instanceof Error ? failure.message : String(failure) })))
      .finally(() => setBusyId((current) => (current === id ? null : current)));
  };

  return (
    <>
      {visible.map((connector) => (
        <EventConnectorTile
          key={connector.id}
          connector={connector}
          busy={busyId === connector.id}
          error={errors[connector.id] ?? null}
          onConnect={(secret) => run(connector.id, { enabled: true, secret })}
          onDisconnect={() => run(connector.id, { enabled: false, secret: "" })}
        />
      ))}
    </>
  );
}
