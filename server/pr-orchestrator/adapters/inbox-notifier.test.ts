import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Notification } from "../../../shared/notification.ts";
import { createExternalApprovals } from "../../external-approvals.ts";
import { createPlaceInbox, type InboxViewer, type PlaceInboxDeps } from "../../host/place-inbox.ts";
import type { RequestAuth } from "../../request-auth.ts";
import { createInboxNotifier, ensurePullRequestsBot } from "./inbox-notifier.ts";
import type { InboxParts } from "./build.ts";

const OWNER = { kind: "owner-session" } as unknown as RequestAuth;
const SUBJECT = { key: "github:acme/widgets#42", pr: null, label: "acme/widgets#42" };
const ANSWERS = [{ id: "fix", label: "Fix it" }, { id: "leave", label: "Leave it" }];
const APPROVAL = [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }];

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Bot = { id: string; name: string; threadId: string; color: string; description: string; notifications?: boolean };
type Line = { id: string; at: number; role: string; kind: string; card?: Record<string, unknown> };

function world() {
  const dataDir = mkdtempSync(join(tmpdir(), "inbox-notifier-"));
  dirs.push(dataDir);
  const bots = new Map<string, Bot>();
  const threads = new Map<string, Line[]>();
  let serial = 0;
  let clock = 1_000;
  const sent: Notification[] = [];
  const store = {
    bot: (id: string) => bots.get(id),
    createBot: vi.fn((profile: { name: string; description: string }, opts: { id: string; seedMessages: boolean }) => {
      const bot = { id: opts.id, name: profile.name, description: profile.description, threadId: `${opts.id}-thread`, color: "blue" };
      bots.set(bot.id, bot);
      return bot;
    }),
    botByThread: (threadId: string) => [...bots.values()].find(bot => bot.threadId === threadId),
    taskByThread: () => undefined,
    groupByThread: () => undefined,
    appendMessage: (threadId: string, line: Omit<Line, "id" | "at">) => {
      const message = { ...line, id: `m${++serial}`, at: ++clock };
      threads.set(threadId, [...(threads.get(threadId) ?? []), message]);
      return message;
    },
    patchMessage: (threadId: string, id: string, fields: Partial<Line>) => {
      threads.set(threadId, (threads.get(threadId) ?? []).map(line => (line.id === id ? { ...line, ...fields } : line)));
    },
    messagesFor: (threadId: string) => threads.get(threadId) ?? [],
    activePath: (threadId: string) => threads.get(threadId) ?? [],
    patchTask: () => undefined, patchGroup: () => undefined,
    onChange: () => () => undefined,
  };
  const inbox = createPlaceInbox({
    dataDir, store: store as unknown as PlaceInboxDeps["store"],
    openCards: () => [...threads.entries()].flatMap(([threadId, lines]) => lines
      .filter(line => line.card && !line.card.answered && !line.card.dismissed)
      .map(line => ({ threadId, id: line.id, at: line.at, fromBotId: null, card: JSON.stringify(line.card) }))),
    live: () => false,
    viewer: () => ({ kind: "owner" }) as InboxViewer,
    sees: () => true, mayAnswer: () => true, guestOf: () => null, guestName: () => undefined, handedBy: () => null,
    send: one => sent.push(one), now: () => clock,
  });
  const answered: Array<[string, string, string]> = [];
  const approvals = createExternalApprovals({ store: store as never });
  const notify: InboxParts["notify"] = (notification, how) => { if (notification) sent.push(inbox.route(notification, how) ?? notification); };
  const make = (over: { approvals?: typeof approvals } = {}) => createInboxNotifier({
    store: store as unknown as InboxParts["store"], approvals: over.approvals ?? approvals, notify,
    answer: (subject, decisionId, answer) => { answered.push([subject, decisionId, answer]); },
    log: () => undefined,
  });
  const requestIdOf = (cardId: string) => cardId.slice(cardId.indexOf(":") + 1);
  const needsYou = () => inbox.view(OWNER).rows.filter(row => row.tab === "needs-you");
  return { store, bots, threads, inbox, approvals, answered, sent, make, requestIdOf, needsYou, bot: () => bots.get("pr-orchestrator")! };
}

const decision = (id: string) => ({ subject: SUBJECT, title: "Review needs you", body: "Three findings", decisionId: id });

describe("inbox notifier", () => {
  it("creates the Pull requests conversation once", async () => {
    const w = world();
    const notifier = w.make();
    await notifier.card("decision", decision("d1"), ANSWERS);
    await notifier.card("decision", decision("d2"), ANSWERS);
    expect(w.store.createBot).toHaveBeenCalledTimes(1);
    expect(w.store.createBot).toHaveBeenCalledWith(
      { name: "Pull requests", description: expect.stringContaining("pull requests") },
      { id: "pr-orchestrator", seedMessages: false },
    );
    expect(ensurePullRequestsBot(w.store as never)).toBe(w.bot());
  });

  it("opens a decision card with the configured choices and returns the answer id for the tapped label", async () => {
    const w = world();
    const { cardId } = await w.make().card("decision", decision("d1"), ANSWERS);
    const [message] = w.threads.get("pr-orchestrator-thread")!;
    expect(cardId).toBe(`${message!.id}:${w.requestIdOf(cardId)}`);
    expect(message!.card).toMatchObject({ options: ["Fix it", "Leave it"], requestType: "question", title: "Review needs you", subtitle: "Three findings" });
    expect(w.approvals.answer(w.requestIdOf(cardId), "answer", "Leave it")).toBe("answered");
    await Promise.resolve();
    expect(w.answered).toEqual([[SUBJECT.key, "d1", "leave"]]);
  });

  it("opens an approval card whose Approve button answers approve", async () => {
    const w = world();
    const { cardId } = await w.make().card("approve_action", decision("d2"), APPROVAL);
    w.approvals.answer(w.requestIdOf(cardId), "answer", "Approve");
    await Promise.resolve();
    expect(w.answered).toEqual([[SUBJECT.key, "d2", "approve"]]);
  });

  it("drops a tap whose label is not one of its buttons", async () => {
    const w = world();
    const { cardId } = await w.make().card("decision", decision("d1"), ANSWERS);
    w.approvals.answer(w.requestIdOf(cardId), "answer", "Something else");
    await Promise.resolve();
    expect(w.answered).toEqual([]);
  });

  it("returns the same card for the same decision id", async () => {
    const w = world();
    const notifier = w.make();
    const first = await notifier.card("decision", decision("d1"), ANSWERS);
    expect(await notifier.card("decision", decision("d1"), ANSWERS)).toEqual(first);
    expect(w.threads.get("pr-orchestrator-thread")).toHaveLength(1);
  });

  it("adopts its card after a restart and delivers the next tap", async () => {
    const w = world();
    const { cardId } = await w.make().card("decision", decision("d1"), ANSWERS);
    const restarted = createExternalApprovals({ store: w.store as never });
    const notifier = w.make({ approvals: restarted });
    // The labels read differently today; the card's own buttons still map by position.
    const renamed = [{ id: "fix", label: "Fix it now" }, { id: "leave", label: "Leave it alone" }];
    expect(notifier.adopt(cardId, { kind: "decision", decisionId: "d1", subject: SUBJECT, answers: renamed })).toBe(true);
    expect(restarted.answer(w.requestIdOf(cardId), "answer", "Fix it")).toBe("answered");
    await Promise.resolve();
    expect(w.answered).toEqual([[SUBJECT.key, "d1", "fix"]]);
    expect(notifier.adopt("missing:card", { kind: "decision", decisionId: "d9", subject: SUBJECT, answers: ANSWERS })).toBe(false);
    expect(notifier.adopt("no-colon", { kind: "decision", decisionId: "d9", subject: SUBJECT, answers: ANSWERS })).toBe(false);
  });

  it("keeps the tapped decision choice after a restart even when the configured choices changed", async () => {
    const w = world();
    const choices = [{ id: "Yes", label: "Yes" }, { id: "No", label: "No" }, { id: "Wait", label: "Wait" }];
    const { cardId } = await w.make().card("decision", decision("d1"), choices);
    const restarted = createExternalApprovals({ store: w.store as never });
    const today = [{ id: "No", label: "No" }, { id: "Yes", label: "Yes" }];
    expect(w.make({ approvals: restarted }).adopt(cardId, { kind: "decision", decisionId: "d1", subject: SUBJECT, answers: today })).toBe(true);
    expect(restarted.answer(w.requestIdOf(cardId), "answer", "Wait")).toBe("answered");
    await Promise.resolve();
    expect(w.answered).toEqual([[SUBJECT.key, "d1", "Wait"]]);
  });

  it("does not adopt a positional card whose number of buttons differs from today's answers", async () => {
    const w = world();
    const { cardId } = await w.make().card("approve_action", decision("d2"), APPROVAL);
    const restarted = createExternalApprovals({ store: w.store as never });
    expect(w.make({ approvals: restarted }).adopt(cardId, { kind: "approve_action", decisionId: "d2", subject: SUBJECT, answers: APPROVAL.slice(0, 1) })).toBe(false);
    expect(restarted.has("pr-orchestrator:d2")).toBe(false);
  });

  it("redacts secrets in card text and notifications", async () => {
    const w = world();
    const secret = "ghp_" + "a".repeat(36);
    await w.make().card("command_failed", { ...decision("d3"), title: `Merge failed ${secret}`, body: `https://x:${secret}@example.com` }, [{ id: "understood", label: "Understood" }]);
    const [message] = w.threads.get("pr-orchestrator-thread")!;
    expect(JSON.stringify(message!.card)).not.toContain(secret);
    expect(JSON.stringify(w.sent)).not.toContain(secret);
  });

  it("puts a notice in the Inbox as one unread line and posts nothing in the card thread", async () => {
    const w = world();
    const notifier = w.make();
    await notifier.card("decision", decision("d1"), ANSWERS);
    const before = w.threads.get("pr-orchestrator-thread")!.length;
    await notifier.notice("merged", "Merged acme/widgets#42 as abc123.", SUBJECT);
    expect(w.threads.get("pr-orchestrator-thread")).toHaveLength(before);
    const lines = w.inbox.view(OWNER).rows.filter(row => row.tab === "info");
    expect(lines).toMatchObject([{ kind: "result", unread: true, text: "Merged acme/widgets#42 as abc123.", from: { name: "Pull requests" } }]);
    expect(w.sent.map(one => one.kind)).toEqual(["question", "done"]);
    expect(w.sent[1]).toMatchObject({ botId: "pr-orchestrator" });
  });

  it("keeps two open cards and a notice all visible in the Inbox", async () => {
    const w = world();
    const notifier = w.make();
    await notifier.card("decision", decision("d1"), ANSWERS);
    await notifier.card("approve_action", decision("d2"), APPROVAL);
    await notifier.notice("merged", "Merged one.", SUBJECT);
    expect(w.needsYou()).toHaveLength(2);
    expect(w.inbox.view(OWNER).rows.filter(row => row.tab === "info")).toHaveLength(1);
  });

  it("closes its card when the question is no longer open and dismisses an earlier copy of a reopened card", async () => {
    const w = world();
    const notifier = w.make();
    await notifier.card("decision", decision("d1"), ANSWERS);
    await notifier.card("decision", decision("d2"), ANSWERS);
    const earlierCopy = w.approvals.openCard({ key: "someone-else:old", threadId: "pr-orchestrator-thread", title: "Old", subtitle: "", tool: "", choices: ["x"], onAnswer: () => undefined })!;
    // A run that restarted lost the key of the earlier copy: only the persisted card is left.
    w.approvals.close("someone-else:old");
    w.store.patchMessage("pr-orchestrator-thread", earlierCopy.messageId, { card: { requestId: earlierCopy.requestId, requestType: "question", options: ["x"], title: "Old", subtitle: "" } });
    notifier.reconcile(new Set(["d2"]));
    const cards = w.threads.get("pr-orchestrator-thread")!.map(line => line.card!);
    expect(cards.map(card => card.dismissed === true)).toEqual([true, false, true]);
    expect(w.needsYou()).toHaveLength(1);
  });

  it("notifies once for each card kind it opens, and not again for the same card", async () => {
    const w = world();
    const notifier = w.make();
    await notifier.card("decision", decision("d1"), ANSWERS);
    await notifier.card("decision", decision("d1"), ANSWERS);
    await notifier.card("approve_action", decision("d2"), APPROVAL);
    await notifier.card("command_failed", decision("d3"), [{ id: "understood", label: "Understood" }]);
    expect(w.sent.map(one => one.kind)).toEqual(["question", "approval", "question"]);
    expect(w.sent[0]).toMatchObject({ botId: "pr-orchestrator", threadId: "pr-orchestrator-thread", body: "acme/widgets#42: Review needs you" });
  });

  it("sends no notification when it adopts open cards after a restart or closes one", async () => {
    const w = world();
    const { cardId } = await w.make().card("decision", decision("d1"), ANSWERS);
    w.sent.length = 0;
    const notifier = w.make({ approvals: createExternalApprovals({ store: w.store as never }) });
    expect(notifier.adopt(cardId, { kind: "decision", decisionId: "d1", subject: SUBJECT, answers: ANSWERS })).toBe(true);
    notifier.reconcile(new Set());
    expect(w.sent).toEqual([]);
  });

  it("never closes a card that another owner of external approvals opened", async () => {
    const w = world();
    const notifier = w.make();
    await notifier.card("decision", decision("d1"), ANSWERS);
    w.approvals.open({ key: "paseo:agent/req", threadId: "paseo-thread", title: "Run?", subtitle: "", tool: "Bash", onAnswer: () => undefined });
    notifier.reconcile(new Set());
    expect(w.approvals.has("paseo:agent/req")).toBe(true);
    expect(w.approvals.has("pr-orchestrator:d1")).toBe(false);
    expect(w.threads.get("paseo-thread")![0]!.card).not.toHaveProperty("dismissed");
  });
});
