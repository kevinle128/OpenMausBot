import { Check, ExternalLink, Github, Gitlab, Loader2 } from "lucide-react";
import { useState } from "react";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import type { ForgeApp } from "@/lib/forge-apps";

const TOKEN_URL: Record<ForgeApp["id"], (baseUrl: string) => string> = {
  github: () => "https://github.com/settings/tokens?type=beta",
  gitlab: (baseUrl) => `${baseUrl.replace(/\/+$/, "")}/-/user_settings/personal_access_tokens`,
};

const PERMS_HINT: Record<ForgeApp["id"], string> = {
  github: "Required PAT permissions: Fine-grained (Metadata, Pull requests, Contents, Checks) or classic (repo).",
  gitlab: "Required PAT scopes: api (comment/merge) or read_api (list projects & read MRs).",
};

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** Unified Native Forge App tile (GitHub / self-hosted GitLab) inside Apps → Developer tools. */
export function EventConnectorTile({ app, busy, error, onConnect, onDisconnect }: {
  app: ForgeApp;
  busy: boolean;
  error: string | null;
  onConnect: (input: { token: string; baseUrl?: string }) => void;
  onDisconnect: () => void;
}) {
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState(app.baseUrl);
  const isGitLab = app.id === "gitlab";
  const canConnect = token.trim().length > 0 && (!isGitLab || baseUrl.trim().length > 0);
  const Icon = isGitLab ? Gitlab : Github;

  const submit = () => {
    if (!canConnect || busy) return;
    onConnect({ token: token.trim(), ...(isGitLab ? { baseUrl: baseUrl.trim() } : {}) });
    setToken("");
  };

  const subtitle = app.connected
    ? [app.login ? `@${app.login}` : null, isGitLab ? hostOf(app.baseUrl) : null].filter(Boolean).join(" · ") || app.description
    : app.description;

  return (
    <div
      data-event-source-tile={app.id}
      className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[8px] bg-control text-ink">
          <Icon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{app.title}</span>
            {app.connected && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
          </div>
          <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={subtitle}>{subtitle}</p>
        </div>
        <button
          type="button"
          aria-label={t(app.connected ? "hostedMcp.disconnect" : "hostedMcp.connect", { service: app.title })}
          disabled={busy || (!app.connected && !canConnect)}
          onClick={() => (app.connected ? onDisconnect() : submit())}
          className="inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : t(app.connected ? "connectors.disconnect" : "connectors.action.connect")}
        </button>
      </div>
      <div className="ps-[52px]">
        {!app.connected && (
          <div className="mt-2 flex flex-col items-start gap-2">
            {isGitLab && (
              <input
                type="url"
                value={baseUrl}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                aria-label="GitLab server URL"
                placeholder="https://git.oceanlabs.dev"
                onChange={(event) => setBaseUrl(event.target.value)}
                className="h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/50"
              />
            )}
            <input
              type="password"
              value={token}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              aria-label={t("hostedMcp.keyLabel", { service: app.title })}
              placeholder={t("hostedMcp.keyPlaceholder", { service: app.title })}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              className="h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
            <p className="text-[11.5px] leading-4 text-ink-secondary">{PERMS_HINT[app.id]}</p>
            <button
              type="button"
              onClick={() => void openExternalLink(TOKEN_URL[app.id](baseUrl || app.baseUrl))}
              className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-text hover:underline"
            >
              {t("hostedMcp.getKey", { service: app.title })}
              <ExternalLink size={11} aria-hidden="true" />
            </button>
          </div>
        )}
        {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
      </div>
    </div>
  );
}
