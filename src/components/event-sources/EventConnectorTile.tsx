import { Check, Github, Gitlab, Loader2 } from "lucide-react";
import { useState, type ComponentType } from "react";
import { t } from "@/lib/i18n";
import { eventConnectorConnected, type EventConnector } from "@/lib/event-connectors";
import { ServiceIcon } from "../ServiceIcon";

const GLYPHS: Record<string, ComponentType<{ size?: number; className?: string }>> = { github: Github, gitlab: Gitlab };

function ConnectorIcon({ connector }: { connector: EventConnector }) {
  const Glyph = "glyph" in connector.icon ? GLYPHS[connector.icon.glyph] : undefined;
  if (Glyph) return <span className="flex size-10 shrink-0 items-center justify-center rounded-[8px] bg-control text-ink"><Glyph size={22} /></span>;
  const logo = "image" in connector.icon ? connector.icon.image : null;
  return <ServiceIcon card={{ logo, domain: null, label: connector.title }} className="size-10 shrink-0 rounded-[8px]" />;
}

/** Standard Apps tile for an event connector: matches key-based Developer tools apps (Connect + key input / Disconnect). */
export function EventConnectorTile({ connector, busy, error, onConnect, onDisconnect }: {
  connector: EventConnector;
  busy: boolean;
  error: string | null;
  /** Resolves true once the secret is saved; the input keeps the pasted key until then. */
  onConnect: (secret: string) => Promise<boolean>;
  onDisconnect: () => void;
}) {
  const [secret, setSecret] = useState("");
  const connected = eventConnectorConnected(connector);
  const canConnect = secret.trim().length > 0;

  const submit = () => {
    const trimmed = secret.trim();
    if (!trimmed || busy) return;
    void onConnect(trimmed).then((saved) => { if (saved) setSecret(""); });
  };

  return (
    <div
      data-event-source-tile={connector.id}
      className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40"
    >
      <div className="flex items-center gap-3">
        <ConnectorIcon connector={connector} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{connector.title}</span>
            {connected && <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />}
          </div>
          <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={connector.description}>{connector.description}</p>
        </div>
        <button
          type="button"
          aria-label={t(connected ? "hostedMcp.disconnect" : "hostedMcp.connect", { service: connector.title })}
          disabled={busy || (!connected && !canConnect)}
          onClick={() => (connected ? onDisconnect() : submit())}
          className="inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink hover:bg-raised-hover disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : t(connected ? "connectors.disconnect" : "connectors.action.connect")}
        </button>
      </div>
      <div className="ps-[52px]">
        {!connected && (
          <div className="mt-2">
            <input
              type="password"
              value={secret}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              aria-label={t("hostedMcp.keyLabel", { service: connector.title })}
              placeholder={t("hostedMcp.keyPlaceholder", { service: connector.title })}
              onChange={(event) => setSecret(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
              className="h-8 w-full min-w-0 rounded-lg bg-inset px-2.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent/50"
            />
          </div>
        )}
        {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
      </div>
    </div>
  );
}
