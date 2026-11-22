import type { NotifierPort } from "../ports.ts";
import type { AdapterContext, InboxParts } from "./build.ts";

/** The Inbox notifier, or null while this install has none. */
export function inboxNotifier(_inbox: InboxParts | null, _ctx: AdapterContext): NotifierPort | null {
  return null;
}
