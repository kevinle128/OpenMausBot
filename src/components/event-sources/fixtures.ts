import type { EventConnector } from "@/lib/event-connectors";

/** A connector as the API returns it. Tests start from this and change what they need. */
export function connectorFixture(over: Partial<EventConnector> = {}): EventConnector {
  return {
    id: "github-event", title: "GitHub Event", description: "Pull request events from the hub.", icon: { glyph: "github" }, delivery: "inbound-http",
    enabled: false, intakePath: "/events/github-event", intakeUrl: "https://hooks.example.test/events/github-event",
    secretName: "GITHUB_EVENT_HUB_SECRET", secretPresent: false,
    settings: { toleranceSeconds: 300 },
    settingsSchema: { type: "object", properties: { toleranceSeconds: { type: "integer", minimum: 30, maximum: 900, default: 300 } }, additionalProperties: false },
    eventTypes: [{ type: "pr.opened", title: "PR opened", description: "A pull request was opened.", payloadSchema: { type: "object", properties: { number: { type: "integer" } } } }],
    status: { lastEventAt: null, events24h: 0, lastError: null, lastErrorAt: null, signatureFailures24h: 0 },
    usedBy: [{ routineId: "run-ci-fix-workflow", name: "Fix CI", active: true, describe: "When CI fails, run the fix workflow." }],
    ...over,
  };
}
