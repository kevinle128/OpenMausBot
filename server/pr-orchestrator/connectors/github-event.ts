import type { ConnectorDefinition } from "../ports.ts";
import { HUB_EMITS, hubDelivery, type HubSettings } from "./hub-delivery.ts";

export const githubEvent: ConnectorDefinition<HubSettings> = {
  id: "github-event",
  title: "GitHub Event",
  description: "Pull request events from git-event-hub: opened, pushed, CI, review, comments, conflicts, merged, closed.",
  icon: { glyph: "github" },
  emits: HUB_EMITS,
  subjectRule: { forge: "github" },
  secret: { required: true, defaultName: "GITHUB_EVENT_HUB_SECRET" },
  defaultInstance: { enabled: false, settings: { toleranceSeconds: 300 } },
  ...hubDelivery,
};
