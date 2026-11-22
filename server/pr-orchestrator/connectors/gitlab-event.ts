import type { ConnectorDefinition } from "../ports.ts";
import { HUB_EMITS, hubDelivery, type HubSettings } from "./hub-delivery.ts";

export const gitlabEvent: ConnectorDefinition<HubSettings> = {
  id: "gitlab-event",
  title: "GitLab Event",
  description: "Pull request events from git-event-hub: opened, pushed, CI, review, comments, conflicts, merged, closed.",
  icon: { glyph: "gitlab" },
  emits: HUB_EMITS,
  subjectRule: { forge: "gitlab" },
  secret: { required: true, defaultName: "GITLAB_EVENT_HUB_SECRET" },
  defaultInstance: { enabled: false, settings: { toleranceSeconds: 300 } },
  ...hubDelivery,
};
