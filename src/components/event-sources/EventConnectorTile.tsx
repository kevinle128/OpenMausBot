import { Github, Gitlab } from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { EventConnector } from "@/lib/event-connectors";
import { ServiceIcon } from "../ServiceIcon";
import { Switch } from "../SettingsPrimitives";
import type { EventConnectorState } from "./event-connector-status";

const GLYPHS: Record<string, ComponentType<{ size?: number; className?: string }>> = { github: Github, gitlab: Gitlab };

const STATE_DOT: Record<EventConnectorState, string> = {
  off: "bg-ink-tertiary", needs_setup: "bg-warning", waiting: "bg-ink-secondary", receiving: "bg-success", error: "bg-danger",
};

/** The connector's icon: a known glyph, its image, or the initial of its title. */
function ConnectorIcon({ connector }: { connector: EventConnector }) {
  const Glyph = "glyph" in connector.icon ? GLYPHS[connector.icon.glyph] : undefined;
  if (Glyph) return <span className="flex size-10 shrink-0 items-center justify-center rounded-[8px] bg-control text-ink"><Glyph size={22} /></span>;
  const logo = "image" in connector.icon ? connector.icon.image : null;
  return <ServiceIcon card={{ logo, domain: null, label: connector.title }} className="size-10 shrink-0 rounded-[8px]" />;
}

export function EventConnectorTile({ connector, state, open, busy, onOpen, onToggle }: {
  connector: EventConnector;
  state: EventConnectorState;
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const stateLabel = t(`eventSources.state.${state}` as LocaleKey);
  return (
    <div
      data-event-source-tile={connector.id}
      data-event-source-state={state}
      className={cn("flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-raised/40", open && "bg-raised/40")}
    >
      <button type="button" aria-expanded={open} onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-start">
        <ConnectorIcon connector={connector} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{connector.title}</span>
            <span className="shrink-0 rounded-full bg-control px-1.5 text-[11px] leading-[18px] text-ink-secondary">{t("eventSources.sendsEvents")}</span>
          </span>
          <span className="block truncate text-[13px] leading-[18px] text-ink-secondary" title={connector.description}>{connector.description}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[12px] leading-4 text-ink-secondary">
            <span aria-hidden className={cn("size-2 rounded-full", STATE_DOT[state])} />
            <span data-event-source-state-label>{stateLabel}</span>
          </span>
        </span>
      </button>
      <Switch checked={connector.enabled} disabled={busy} aria-label={t("eventSources.toggle", { name: connector.title })} onClick={() => onToggle(!connector.enabled)} />
    </div>
  );
}
