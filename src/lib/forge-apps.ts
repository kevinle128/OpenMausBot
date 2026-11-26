// Client helpers for unified native Forge Apps (GitHub / self-hosted GitLab) and the reusable Resource Picker API.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";

export type ForgeId = "github" | "gitlab";

export interface ForgeApp {
  id: ForgeId;
  title: string;
  description: string;
  baseUrl: string;
  connected: boolean;
  login: string | null;
}

export interface ResourceItem {
  id: string;
  label: string;
  meta?: string;
  group: "wildcard" | "recent" | "all";
}

export const FORGE_APPS_CATEGORY = "Developer tools";

export function forgeMatchesSearch(app: Pick<ForgeApp, "id" | "title" | "description">, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  const hay = `${app.title} ${app.id} ${app.description} developer tools pull request merge request repo project`.toLowerCase();
  return query.split(/\s+/).every((part) => hay.includes(part));
}

export async function loadForgeApps(): Promise<ForgeApp[]> {
  const res = await api<{ apps?: ForgeApp[] }>("/api/apps/forge");
  return res.apps ?? [];
}

export function connectForgeApp(id: ForgeId, input: { token: string; baseUrl?: string }): Promise<ForgeApp> {
  return api<ForgeApp>(`/api/apps/forge/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function disconnectForgeApp(id: ForgeId): Promise<ForgeApp> {
  return api<ForgeApp>(`/api/apps/forge/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function loadAppResources(slug: string, kind = "repositories", query = ""): Promise<ResourceItem[]> {
  const qs = new URLSearchParams({ kind, ...(query.trim() ? { q: query.trim() } : {}) });
  const res = await api<{ items?: ResourceItem[] }>(`/api/apps/${encodeURIComponent(slug)}/resources?${qs}`);
  return res.items ?? [];
}

export function useForgeApps(refreshKey = 0) {
  const [apps, setApps] = useState<ForgeApp[] | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const started = ++generation.current;
    try {
      const loaded = await loadForgeApps();
      if (generation.current === started) setApps(loaded);
    } catch {
      setApps((current) => current);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const replace = useCallback((updated: ForgeApp) => {
    generation.current++;
    setApps((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? current);
  }, []);

  return { apps, refresh, replace };
}
