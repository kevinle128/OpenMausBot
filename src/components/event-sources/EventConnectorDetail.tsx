import { Check, Copy, Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { lastWhen } from "@/lib/automations";
import { useAppTriggers } from "@/lib/app-triggers";
import { t } from "@/lib/i18n";
import type { EventConnector, EventConnectorPatch } from "@/lib/event-connectors";
import { useStore } from "@/state/store";
import { ConnectorSettingsForm } from "./ConnectorSettingsForm";

function CopyButton({ text, label }: { text: string; label: string }) {
  const { state, copy } = useCopyFeedback(text);
  return (
    <button type="button" onClick={copy} aria-label={label} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-control px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:brightness-110">
      {state === "copied" ? <Check size={12} /> : <Copy size={12} />}
      {state === "copied" ? t("eventSources.copied") : state === "failed" ? t("eventSources.copyFailed") : t("eventSources.copy")}
    </button>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[12px] font-semibold uppercase tracking-wider text-ink-tertiary">{title}</h4>
      {children}
    </section>
  );
}

/** The sink to paste into the hub's config: the address, the name of the environment variable that holds the key (never its value) and the forge. */
function hubSnippet(connector: EventConnector): string {
  const provider = (connector.use ?? connector.id).split("-")[0] ?? connector.id;
  const url = connector.intakeUrl ?? `${t("eventSources.snippet.address")}${connector.intakePath ?? ""}`;
  return ["sinks:", "  - type: omb", `    url: ${url}`, `    secretEnv: ${connector.secretName ?? ""}`, "    batchSize: 20", "    filter:", `      providers: [${provider}]`].join("\n");
}

export function EventConnectorDetail({ connector, busy, error, onSave, onOpenVault }: {
  connector: EventConnector;
  busy: boolean;
  error: string | null;
  onSave: (patch: EventConnectorPatch) => Promise<void>;
  onOpenVault: () => void;
}) {
  const { status } = connector;
  const snippet = connector.delivery === "inbound-http" && connector.intakePath ? hubSnippet(connector) : null;
  const [typeOpen, setTypeOpen] = useState<string | null>(null);
  const { state, dispatch } = useStore();
  const { loaded, triggers } = useAppTriggers();
  const bots = (state.bots ?? []).filter((bot) => !bot.hidden);
  const botName = (botId: string) => bots.find((bot) => bot.id === botId)?.name ?? t("routines.unavailableBot");
  const routines = triggers.filter((trigger) => trigger.app === connector.id);
  return (
    <div data-event-source-detail={connector.id} className="mt-2 flex flex-col gap-5 rounded-xl bg-raised/40 px-4 py-4">
      {error && <p role="alert" className="rounded-lg bg-danger/10 px-2.5 py-1.5 text-[12px] text-danger">{error}</p>}

      <Block title={t("eventSources.setup")}>
        {connector.intakePath && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">{t("eventSources.intakeUrl")}</div>
              <code className="block break-all text-[12px] text-ink-secondary">{connector.intakeUrl ?? connector.intakePath}</code>
            </div>
            {connector.intakeUrl && <CopyButton text={connector.intakeUrl} label={t("eventSources.copyIntakeUrl")} />}
          </div>
        )}
        {connector.secretName && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">{t("eventSources.secretName")}</div>
              <code className="block break-all text-[12px] text-ink-secondary">{connector.secretName}</code>
              <span data-secret-state className={cn("text-[12px]", connector.secretPresent ? "text-success" : "text-warning")}>
                {connector.secretPresent ? t("eventSources.secretSaved") : t("eventSources.secretMissing")}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <CopyButton text={connector.secretName} label={t("eventSources.copySecretName")} />
              <button type="button" onClick={onOpenVault} className="rounded-full bg-control px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:brightness-110">{t("eventSources.openVault")}</button>
            </div>
          </div>
        )}
        {snippet && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-ink">{t("eventSources.hubSnippet")}</span>
              <CopyButton text={snippet} label={t("eventSources.copySnippet")} />
            </div>
            <pre className="overflow-x-auto rounded-lg bg-control px-2.5 py-1.5 font-mono text-[12px] text-ink-secondary">{snippet}</pre>
          </div>
        )}
      </Block>

      <Block title={t("eventSources.status")}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <dt className="text-ink-secondary">{t("eventSources.lastEvent")}</dt>
          <dd className="text-ink">{status.lastEventAt === null ? t("eventSources.none") : lastWhen(status.lastEventAt)}</dd>
          <dt className="text-ink-secondary">{t("eventSources.events24h")}</dt>
          <dd className="text-ink">{status.events24h}</dd>
          <dt className="text-ink-secondary">{t("eventSources.signatureFailures")}</dt>
          <dd className="text-ink">{status.signatureFailures24h}</dd>
          <dt className="text-ink-secondary">{t("eventSources.lastError")}</dt>
          <dd className="break-words text-ink">{status.lastError === null ? t("eventSources.none") : `${status.lastErrorAt === null ? "" : `${lastWhen(status.lastErrorAt)} · `}${status.lastError}`}</dd>
        </dl>
      </Block>

      <Block title={t("eventSources.eventTypes")}>
        <ul className="flex flex-col gap-1">
          {connector.eventTypes.map((type) => (
            <li key={type.type} data-event-type={type.type}>
              <details
                open={typeOpen === type.type}
                onToggle={(event) => {
                  const isOpen = event.currentTarget.open;
                  setTypeOpen((current) => (isOpen ? type.type : current === type.type ? null : current));
                }}
              >
                <summary className="cursor-pointer text-[13px] text-ink"><span className="font-medium">{type.title}</span> <span className="text-ink-secondary">{type.description}</span></summary>
                <pre className="mt-1 overflow-x-auto rounded-lg bg-control px-2.5 py-1.5 font-mono text-[12px] text-ink-secondary">{JSON.stringify(type.payloadSchema, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      </Block>

      <Block title={t("eventSources.usedBy")}>
        {loaded && routines.length === 0 && <p className="text-[13px] text-ink-secondary">{t("eventSources.usedByBotsNone")}</p>}
        {routines.length > 0 && (
          <ul className="flex flex-col gap-1">{routines.map((trigger) => (
            <li key={trigger.id} data-app-trigger={trigger.id} className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 text-ink"><span className="font-medium">{botName(trigger.botId)}</span> <span className="text-ink-secondary">{trigger.name}</span></span>
              <span className={cn("shrink-0 text-[12px]", trigger.enabled ? "text-success" : "text-ink-tertiary")}>{trigger.enabled ? t("eventSources.routineActive") : t("eventSources.usedByPaused")}</span>
            </li>
          ))}</ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!connector.enabled} onClick={() => { if (connector.enabled) dispatch({ type: "showRoutines", view: "list", newApp: connector.id }); }} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-control px-2.5 py-1 text-[12px] font-medium text-ink transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100">
            <Plus size={12} aria-hidden="true" />{t("eventSources.usedByAdd")}
          </button>
          {!connector.enabled && <span className="text-[12px] text-ink-secondary">{t("eventSources.usedByAddOff")}</span>}
        </div>
      </Block>

      <Block title={t("eventSources.settings")}>
        <ConnectorSettingsForm
          key={JSON.stringify(connector.settings)}
          schema={connector.settingsSchema}
          settings={connector.settings}
          onSave={(settings) => onSave({ settings })}
        />
      </Block>
      {busy && <span className="sr-only" role="status">{t("eventSources.settings.saving")}</span>}
    </div>
  );
}
