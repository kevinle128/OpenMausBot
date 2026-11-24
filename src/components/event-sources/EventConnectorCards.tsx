import { useEffect, useState } from "react";
import {
  eventConnectorConnected,
  eventConnectorMatchesSearch,
  inEventConnectorsCategory,
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
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const searching = search.trim().length > 0;
  const visible = (connectors ?? []).filter((connector) => {
    if (filter === "mcp") return false;
    if (!searching && category !== null && !inEventConnectorsCategory(category)) return false;
    if (!searching && filter === "connected" && !eventConnectorConnected(connector)) return false;
    return eventConnectorMatchesSearch(connector, search);
  });
  const connectedCount = (connectors ?? []).filter(eventConnectorConnected).length;

  useEffect(() => {
    onCount?.(connectedCount, visible.length);
  }, [connectedCount, visible.length, onCount]);

  if (visible.length === 0) return null;

  /** Resolves true once the change is saved, false when it failed (the error shows on the tile). */
  const run = (id: string, patch: EventConnectorPatch): Promise<boolean> => {
    setBusy((current) => ({ ...current, [id]: true }));
    setErrors((current) => ({ ...current, [id]: null }));
    return saveEventConnector(id, patch)
      .then((updated) => { replace(updated); return true; })
      .catch((failure) => { setErrors((current) => ({ ...current, [id]: failure instanceof Error ? failure.message : String(failure) })); return false; })
      .finally(() => setBusy((current) => ({ ...current, [id]: false })));
  };

  return (
    <>
      {visible.map((connector) => (
        <EventConnectorTile
          key={connector.id}
          connector={connector}
          busy={busy[connector.id] === true}
          error={errors[connector.id] ?? null}
          onConnect={(secret) => run(connector.id, { enabled: true, secret })}
          onDisconnect={() => { void run(connector.id, { enabled: false, secret: "" }); }}
        />
      ))}
    </>
  );
}
