import { useEffect, useState } from "react";
import {
  connectForgeApp,
  disconnectForgeApp,
  FORGE_APPS_CATEGORY,
  forgeMatchesSearch,
  useForgeApps,
  type ForgeId,
} from "@/lib/forge-apps";
import { EventConnectorTile } from "./EventConnectorTile";

/** Unified GitHub & self-hosted GitLab app tiles rendered inline inside Apps → Developer tools. */
export function EventConnectorCards({ filter, category, search, refreshKey = 0, onCount }: {
  filter: "all" | "connected" | "mcp";
  category: string | null;
  search: string;
  refreshKey?: number;
  onCount?: (connected: number, shown: number) => void;
}) {
  const { apps, replace } = useForgeApps(refreshKey);
  const [busyId, setBusyId] = useState<ForgeId | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const searching = search.trim().length > 0;
  const visible = (apps ?? []).filter((app) => {
    if (filter === "mcp") return false;
    if (!searching && category !== null && category !== FORGE_APPS_CATEGORY) return false;
    if (!searching && filter === "connected" && !app.connected) return false;
    return forgeMatchesSearch(app, search);
  });
  const connectedCount = (apps ?? []).filter((app) => app.connected).length;

  useEffect(() => {
    onCount?.(connectedCount, visible.length);
  }, [connectedCount, visible.length, onCount]);

  if (visible.length === 0) return null;

  const run = (id: ForgeId, task: Promise<Parameters<typeof replace>[0]>) => {
    setBusyId(id);
    setErrors((current) => ({ ...current, [id]: null }));
    task
      .then((updated) => replace(updated))
      .catch((failure) => setErrors((current) => ({ ...current, [id]: failure instanceof Error ? failure.message : String(failure) })))
      .finally(() => setBusyId((current) => (current === id ? null : current)));
  };

  return (
    <>
      {visible.map((app) => (
        <EventConnectorTile
          key={app.id}
          app={app}
          busy={busyId === app.id}
          error={errors[app.id] ?? null}
          onConnect={(input) => run(app.id, connectForgeApp(app.id, input))}
          onDisconnect={() => run(app.id, disconnectForgeApp(app.id))}
        />
      ))}
    </>
  );
}
