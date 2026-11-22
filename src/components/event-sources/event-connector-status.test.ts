import { describe, expect, it } from "vitest";
import { statusOf } from "./event-connector-status";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const connector = (over: { enabled?: boolean; secretPresent?: boolean; status?: Partial<{ lastEventAt: number | null; events24h: number; lastError: string | null; lastErrorAt: number | null; signatureFailures24h: number }> } = {}) => ({
  enabled: over.enabled ?? true,
  secretName: "GITHUB_EVENT_HUB_SECRET",
  secretPresent: over.secretPresent ?? true,
  status: { lastEventAt: null, events24h: 0, lastError: null, lastErrorAt: null, signatureFailures24h: 0, ...over.status },
});

describe("event connector status", () => {
  it("shows off for a connector that is switched off", () => {
    expect(statusOf(connector({ enabled: false, secretPresent: false }), NOW)).toBe("off");
  });

  it("shows needs setup for an enabled connector without its secret", () => {
    expect(statusOf(connector({ secretPresent: false }), NOW)).toBe("needs_setup");
  });

  it("shows error when signature failures happened in the last 24 hours", () => {
    expect(statusOf(connector({ status: { lastEventAt: NOW - HOUR, signatureFailures24h: 2 } }), NOW)).toBe("error");
  });

  it("shows error for a failure newer than the last event, and clears it once an event follows", () => {
    expect(statusOf(connector({ status: { lastEventAt: NOW - 3 * HOUR, lastErrorAt: NOW - HOUR, lastError: "bad payload" } }), NOW)).toBe("error");
    expect(statusOf(connector({ status: { lastEventAt: NOW - HOUR, lastErrorAt: NOW - 3 * HOUR, lastError: "bad payload" } }), NOW)).toBe("receiving");
  });

  it("shows receiving after an event in the last 24 hours and waiting before the first one", () => {
    expect(statusOf(connector({ status: { lastEventAt: NOW - 23 * HOUR } }), NOW)).toBe("receiving");
    expect(statusOf(connector(), NOW)).toBe("waiting");
    expect(statusOf(connector({ status: { lastEventAt: NOW - 25 * HOUR } }), NOW)).toBe("waiting");
  });
});
