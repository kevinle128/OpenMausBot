// Approval cards for a request that did not come from a bot's turn: nothing here belongs to a running engine, so the
// card's own owner settles it. The first answer wins, on this card or at the place the request came from.
import { newId } from "./contracts.ts";
import type { Message, Store } from "./store.ts";

export type ExternalDecision = "allow" | "deny";

export interface ExternalApproval {
  /** The caller's own id for the request; a second open with the same key is ignored while the first is open. */
  key: string;
  threadId: string;
  title: string;
  subtitle: string;
  /** What is asked for, such as the tool's name. The card is an approval only while this is set. */
  tool: string;
  /** With these, the card is a question: one button for each label, and no tool. A tap hands the label to `onAnswer`. */
  choices?: string[];
  /** Runs once, when a person answers the card. A rejection closes the card as unavailable. */
  onAnswer(decision: ExternalDecision, choice?: string): Promise<void> | void;
}

interface Open {
  threadId: string;
  messageId: string;
  requestId: string;
  choices?: string[];
  onAnswer: ExternalApproval["onAnswer"];
}

type ExternalApprovalsStore = Pick<Store, "appendMessage" | "patchMessage" | "messagesFor">;

export function createExternalApprovals(deps: { store: ExternalApprovalsStore; log?: (message: string) => void }) {
  const { store } = deps;
  const open = new Map<string, Open>();
  const byRequest = new Map<string, string>();

  function patch(card: Open, fields: { answered: string; dismissed?: boolean }): void {
    const current = store.messagesFor(card.threadId).find((message: Message) => message.id === card.messageId)?.card;
    if (current) store.patchMessage(card.threadId, card.messageId, { card: { ...current, ...fields } });
  }

  function forget(key: string): Open | undefined {
    const card = open.get(key);
    if (!card) return undefined;
    open.delete(key);
    byRequest.delete(card.requestId);
    return card;
  }

  function deliver(card: Open, send: () => Promise<void> | void): void {
    void Promise.resolve()
      .then(send)
      .catch((error: unknown) => {
        patch(card, { answered: "unavailable", dismissed: true });
        deps.log?.(`external approval could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  return {
    has: (key: string): boolean => open.has(key),
    keys: (): string[] => [...open.keys()],

    /** False when a card for this key is already open. */
    open(approval: ExternalApproval): boolean {
      if (open.has(approval.key)) return false;
      const requestId = newId();
      const message = store.appendMessage(approval.threadId, {
        role: "bot",
        kind: "options",
        card: approval.choices
          ? { title: approval.title, subtitle: approval.subtitle, options: approval.choices, fixedOptions: true, requestId, requestType: "question" }
          : { title: approval.title, subtitle: approval.subtitle, options: ["Allow", "Deny"], requestId, requestType: "permission", tool: approval.tool },
      });
      open.set(approval.key, {
        threadId: approval.threadId, messageId: message.id, requestId, onAnswer: approval.onAnswer, ...(approval.choices ? { choices: approval.choices } : {}),
      });
      byRequest.set(requestId, approval.key);
      return true;
    },

    /** The place the request came from settled it: the card closes with no verdict of ours. */
    close(key: string): void {
      const card = forget(key);
      if (card) patch(card, { answered: "unavailable", dismissed: true });
    },

    /** A tap on a card. True when it was one of these; the verdict goes on to its owner without being waited for. A question
     * card takes only the text of one of its buttons: closing it without a pick leaves the question where it came from. */
    answer(requestId: string, behavior: string | undefined, message?: unknown): boolean {
      const key = byRequest.get(requestId);
      const card = key === undefined ? undefined : forget(key);
      if (!card) return false;
      if (card.choices) {
        const choice = behavior === "answer" && typeof message === "string" ? card.choices.find((label) => label === message) : undefined;
        if (choice === undefined) {
          patch(card, { answered: "unavailable", dismissed: true });
          return true;
        }
        patch(card, { answered: choice });
        deliver(card, () => card.onAnswer("allow", choice));
        return true;
      }
      const decision: ExternalDecision = behavior === "allow" ? "allow" : "deny";
      patch(card, { answered: decision });
      deliver(card, () => card.onAnswer(decision));
      return true;
    },

    /** A card an earlier run left open can never be answered: it is closed. */
    dismissStale(threadId: string): number {
      let dismissed = 0;
      for (const message of store.messagesFor(threadId)) {
        const card = message.card;
        if (!card?.requestId || (card.requestType !== "permission" && card.requestType !== "question") || card.answered || card.dismissed || byRequest.has(card.requestId)) continue;
        store.patchMessage(threadId, message.id, { card: { ...card, answered: "unavailable", dismissed: true } });
        dismissed += 1;
      }
      return dismissed;
    },
  };
}

export type ExternalApprovals = ReturnType<typeof createExternalApprovals>;
