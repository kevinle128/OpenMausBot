import { useState } from "react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { saveEventConnector, useEventConnectors, type EventConnectorPatch } from "@/lib/event-connectors";
import { AppsSection } from "../AppsSection";
import { EventConnectorDetail } from "./EventConnectorDetail";
import { EventConnectorTile } from "./EventConnectorTile";
import { statusOf } from "./event-connector-status";

/** Apps that send events to your routines. They give bots no tools: this list is separate from the tool apps. */
export function EventSourcesSection() {
  const { dispatch } = useStore();
  const [openId, setOpenId] = useState<string | null>(null);
  const { connectors, replace } = useEventConnectors(openId !== null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  if (!connectors || connectors.length === 0) return null;

  const save = async (id: string, patch: EventConnectorPatch) => {
    setBusyId(id);
    try {
      replace(await saveEventConnector(id, patch));
    } finally {
      setBusyId(null);
    }
  };
  const toggle = (id: string, enabled: boolean) => {
    setErrors((current) => ({ ...current, [id]: null }));
    save(id, { enabled }).catch((failure) => {
      setErrors((current) => ({ ...current, [id]: failure instanceof Error ? failure.message : String(failure) }));
      setOpenId(id);
    });
  };
  const openVault = () => {
    dispatch({ type: "togglePlugins", open: false });
    dispatch({ type: "toggleAppSettings", open: true, section: "vault" });
  };
  const now = Date.now();
  const opened = connectors.find((connector) => connector.id === openId);

  return (
    <div className="mt-8">
    <AppsSection id="apps-section-event-sources" title={t("eventSources.title")} note={t("eventSources.note")} after={opened && (
      <EventConnectorDetail
        connector={opened}
        busy={busyId === opened.id}
        error={errors[opened.id] ?? null}
        onSave={(patch) => save(opened.id, patch)}
        onOpenVault={openVault}
      />
    )}>
      {connectors.map((connector) => (
        <EventConnectorTile
          key={connector.id}
          connector={connector}
          state={statusOf(connector, now)}
          open={connector.id === openId}
          busy={busyId === connector.id}
          onOpen={() => setOpenId(connector.id === openId ? null : connector.id)}
          onToggle={(enabled) => toggle(connector.id, enabled)}
        />
      ))}
    </AppsSection>
    </div>
  );
}
