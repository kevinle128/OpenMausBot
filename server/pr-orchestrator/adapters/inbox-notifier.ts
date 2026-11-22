import type { ExternalApproval, ExternalApprovals } from "../../external-approvals.ts";
import { redactSecretsInText } from "../../../shared/redact.ts";
import { buildNotification } from "../../notify.ts";
import { serverLine } from "../../server-lines.ts";
import type { BotRecord } from "../../store.ts";
import type { NotifierPort } from "../ports.ts";
import type { AskKind, SubjectKey } from "../types.ts";
import type { InboxParts } from "./build.ts";

export const PULL_REQUESTS_BOT_ID = "pr-orchestrator";
/** Every key this notifier gives the shared card owner starts with this, so it never meets the keys of other owners. */
const KEY_PREFIX = "pr-orchestrator:";

export interface InboxNotifierDeps {
  store: InboxParts["store"];
  approvals: ExternalApprovals;
  notify: InboxParts["notify"];
  /** Hands the person's answer to the orchestrator that runs now. */
  answer(subjectKey: SubjectKey, decisionId: string, answer: string): void;
  log(line: string): void;
}

/** The "Pull requests" conversation's bot, made on first use. */
export function ensurePullRequestsBot(store: Pick<InboxParts["store"], "bot" | "createBot">): BotRecord {
  const existing = store.bot(PULL_REQUESTS_BOT_ID);
  if (existing) return existing as BotRecord;
  return store.createBot(
    {
      name: serverLine(undefined, "server.prOrchestrator.bot.name"),
      description: serverLine(undefined, "server.prOrchestrator.bot.description"),
    },
    { id: PULL_REQUESTS_BOT_ID, seedMessages: false },
  );
}

type Answers = Array<{ id: string; label: string }>;

/** Cards and notices of the PR orchestrator in the Inbox. The "Pull requests" conversation holds nothing but cards, because
 * a later message in a card's thread hides the card from "needs you" once it is no longer live. */
export function createInboxNotifier(deps: InboxNotifierDeps): Required<NotifierPort> {
  const { approvals } = deps;
  /** decision id → the card it owns, for cards opened or adopted by this run. */
  const cards = new Map<string, string>();
  const keyOf = (decisionId: string) => `${KEY_PREFIX}${decisionId}`;

  function approval(bot: BotRecord, decisionId: string, subject: SubjectKey, content: { title: string; body: string }, labels: string[], ids: string[]): ExternalApproval {
    return {
      key: keyOf(decisionId), threadId: bot.threadId, title: content.title, subtitle: content.body, tool: "", choices: labels,
      onAnswer: (_decision, label) => {
        const index = label === undefined ? -1 : labels.indexOf(label);
        const id = ids[index];
        if (id === undefined) {
          // Thrown, so the card closes as unavailable instead of showing an answer nobody received.
          throw new Error(`an answer to ${decisionId} named no known button`);
        }
        deps.answer(subject, decisionId, id);
      },
    };
  }

  return {
    async card(kind: AskKind, payload, answers: Answers) {
      const held = cards.get(payload.decisionId);
      if (held !== undefined && approvals.has(keyOf(payload.decisionId))) return { cardId: held };
      const bot = ensurePullRequestsBot(deps.store);
      // PR titles and failure reasons come from outside: they may carry credentials, and the card and notification keep them.
      const content = { title: redactSecretsInText(payload.title), body: redactSecretsInText(payload.body) };
      const request = approval(bot, payload.decisionId, payload.subject.key, content, answers.map(a => a.label), answers.map(a => a.id));
      const opened = approvals.openCard(request);
      if (opened === null) {
        // The key is open already, for example a card this run adopted before the ledger knew its id.
        const known = cards.get(payload.decisionId);
        if (known !== undefined) return { cardId: known };
        throw new Error(`a card for ${payload.decisionId} is open but unknown to this run`);
      }
      const cardId = `${opened.messageId}:${opened.requestId}`;
      cards.set(payload.decisionId, cardId);
      // One notification for each card opened, on the path the app uses for questions and approvals. Adopting a card after a
      // restart and closing one send none. The notification opens the "Pull requests" conversation, where the card is.
      deps.notify(buildNotification(kind === "approve_action" ? "approval" : "question", bot, bot.threadId, redactSecretsInText(`${payload.subject.label}: ${content.title}`)));
      return { cardId };
    },

    async notice(_kind, text) {
      const bot = ensurePullRequestsBot(deps.store);
      // A routine "done" line is one unread line in the Inbox. Nothing is appended to the card thread.
      deps.notify(buildNotification("done", bot, bot.threadId, redactSecretsInText(text)), { routine: true });
    },

    adopt(cardId, card) {
      const split = cardId.indexOf(":");
      if (split <= 0) return false;
      const messageId = cardId.slice(0, split);
      const requestId = cardId.slice(split + 1);
      const bot = ensurePullRequestsBot(deps.store);
      const held = deps.store.messagesFor(bot.threadId).find(message => message.id === messageId)?.card;
      // The card's own buttons decide the mapping: its labels may differ from today's i18n text.
      const labels = held?.options ?? card.answers.map(a => a.label);
      // Buttons that name their own answer (the decision choices) keep it even when the configured choices changed since.
      // Other buttons map by position, so a card with another number of buttons is not taken over: a fresh one opens.
      const selfNamed = card.answers.every(a => a.id === a.label);
      const ids = selfNamed ? labels : card.answers.map(a => a.id);
      if (labels.length !== ids.length) return false;
      const request = approval(bot, card.decisionId, card.subject.key, { title: held?.title ?? "", body: held?.subtitle ?? "" }, labels, ids);
      if (!approvals.adopt(request, { messageId, requestId })) return false;
      cards.set(card.decisionId, cardId);
      return true;
    },

    reconcile(openDecisionIds) {
      for (const decisionId of cards.keys()) {
        if (openDecisionIds.has(decisionId)) continue;
        approvals.close(keyOf(decisionId));
        cards.delete(decisionId);
      }
      const bot = deps.store.bot(PULL_REQUESTS_BOT_ID);
      if (bot) approvals.dismissStale(bot.threadId);
    },
  };
}
