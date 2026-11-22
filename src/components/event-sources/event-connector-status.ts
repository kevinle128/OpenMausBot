import type { EventConnector } from "@/lib/event-connectors";

export type EventConnectorState = "off" | "needs_setup" | "waiting" | "receiving" | "error";

const DAY_MS = 24 * 60 * 60 * 1000;

type StatusInput = Pick<EventConnector, "enabled" | "secretName" | "secretPresent" | "status">;

/**
 * What the tile's dot shows:
 * off (the gate is closed); needs setup (open, but the key that signs batches is not in the Vault);
 * error (a bad signature in the last 24 hours, or a failure newer than the last event);
 * receiving (an event in the last 24 hours); waiting (open, nothing lately).
 */
export function statusOf(connector: StatusInput, now: number): EventConnectorState {
  if (!connector.enabled) return "off";
  if (connector.secretName !== null && !connector.secretPresent) return "needs_setup";
  const { lastEventAt, lastErrorAt, signatureFailures24h } = connector.status;
  if (signatureFailures24h > 0) return "error";
  if (lastErrorAt !== null && (lastEventAt === null || lastErrorAt > lastEventAt)) return "error";
  if (lastEventAt !== null && now - lastEventAt < DAY_MS) return "receiving";
  return "waiting";
}
