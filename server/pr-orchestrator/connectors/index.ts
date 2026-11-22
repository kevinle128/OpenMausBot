import { githubEvent } from "./github-event.ts";
import { gitlabEvent } from "./gitlab-event.ts";

export const BUILT_IN_CONNECTORS = [githubEvent, gitlabEvent] as const;
