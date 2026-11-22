import type { NotifierPort } from "../ports.ts";
import type { AdapterContext, InboxParts } from "./build.ts";
import { createInboxNotifier } from "./inbox-notifier.ts";

/** The Inbox notifier, or null while this install has none. */
export function inboxNotifier(inbox: InboxParts | null, ctx: AdapterContext): NotifierPort | null {
  return inbox ? createInboxNotifier({ ...inbox, answer: ctx.answer, log: ctx.log }) : null;
}
