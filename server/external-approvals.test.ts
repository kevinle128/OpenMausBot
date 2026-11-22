import { describe, expect, it, vi } from "vitest";

import { createExternalApprovals, type ExternalApproval } from "./external-approvals.ts";
import type { Message } from "./store.ts";

type Line = Message & { card?: Record<string, unknown> };

function setup() {
  const threads = new Map<string, Line[]>();
  let serial = 0;
  const store = {
    appendMessage: (threadId: string, line: Record<string, unknown>) => {
      const message = { ...line, id: `m${++serial}`, at: serial } as unknown as Line;
      threads.set(threadId, [...(threads.get(threadId) ?? []), message]);
      return message;
    },
    patchMessage: (threadId: string, id: string, fields: Record<string, unknown>) => {
      threads.set(threadId, (threads.get(threadId) ?? []).map(line => (line.id === id ? { ...line, ...fields } : line)));
    },
    messagesFor: (threadId: string) => threads.get(threadId) ?? [],
  };
  const approvals = createExternalApprovals({ store: store as never });
  const cardOf = (threadId: string, id: string) => threads.get(threadId)!.find(line => line.id === id)!.card as Record<string, unknown>;
  return { approvals, store, cardOf, threads };
}

const question = (over: Partial<ExternalApproval> = {}): ExternalApproval => ({
  key: "k1", threadId: "t1", title: "Which?", subtitle: "Pick", tool: "", choices: ["Yes", "No"], onAnswer: () => undefined, ...over,
});

describe("external approvals", () => {
  it("opens one card per key and hands the tapped label to its owner", async () => {
    const f = setup();
    const onAnswer = vi.fn();
    const opened = f.approvals.openCard(question({ onAnswer }));
    expect(opened).toMatchObject({ messageId: expect.any(String), requestId: expect.any(String) });
    expect(f.approvals.openCard(question({ onAnswer }))).toBeNull();
    expect(f.approvals.open(question({ onAnswer }))).toBe(false);
    expect(f.threads.get("t1")).toHaveLength(1);

    expect(f.approvals.answer(opened!.requestId, "answer", "No")).toBe("answered");
    await Promise.resolve();
    expect(onAnswer).toHaveBeenCalledWith("allow", "No");
    expect(f.cardOf("t1", opened!.messageId)).toMatchObject({ answered: "No" });
    expect(f.approvals.has("k1")).toBe(false);
  });

  it("adopts a card that an earlier run opened, so a tap reaches the new owner", async () => {
    const f = setup();
    const earlier = f.approvals.openCard(question({ onAnswer: vi.fn() }))!;
    const restarted = createExternalApprovals({ store: f.store as never });
    const onAnswer = vi.fn();
    expect(restarted.adopt(question({ onAnswer }), earlier)).toBe(true);
    expect(restarted.has("k1")).toBe(true);
    expect(restarted.adopt(question({ onAnswer }), earlier)).toBe(true);
    expect(restarted.adopt(question({ onAnswer }), { ...earlier, requestId: "another" })).toBe(false);

    expect(restarted.answer(earlier.requestId, "answer", "Yes")).toBe("answered");
    await Promise.resolve();
    expect(onAnswer).toHaveBeenCalledWith("allow", "Yes");
  });

  it("refuses to adopt an answered, dismissed or missing card", () => {
    const f = setup();
    const answered = f.approvals.openCard(question({ key: "a" }))!;
    f.approvals.answer(answered.requestId, "answer", "Yes");
    const closed = f.approvals.openCard(question({ key: "b" }))!;
    f.approvals.close("b");
    const fresh = createExternalApprovals({ store: f.store as never });
    expect(fresh.adopt(question({ key: "a" }), answered)).toBe(false);
    expect(fresh.adopt(question({ key: "b" }), closed)).toBe(false);
    expect(fresh.adopt(question({ key: "c" }), { messageId: "gone", requestId: "gone" })).toBe(false);
    expect(fresh.has("a") || fresh.has("b") || fresh.has("c")).toBe(false);
  });

  it("keeps open() unchanged for its existing callers", () => {
    const f = setup();
    expect(f.approvals.open({ key: "p", threadId: "t2", title: "Run?", subtitle: "x", tool: "Bash", onAnswer: () => undefined })).toBe(true);
    const [message] = f.threads.get("t2")!;
    expect(message!.card).toMatchObject({ requestType: "permission", tool: "Bash", options: ["Allow", "Deny"] });
    expect(f.approvals.open({ key: "p", threadId: "t2", title: "Run?", subtitle: "x", tool: "Bash", onAnswer: () => undefined })).toBe(false);
    expect(f.approvals.keys()).toEqual(["p"]);
    f.approvals.close("p");
    expect(f.cardOf("t2", message!.id)).toMatchObject({ answered: "unavailable", dismissed: true });
  });

  it("does not dismiss an adopted card as stale", () => {
    const f = setup();
    const earlier = f.approvals.openCard(question())!;
    const stray = f.approvals.openCard(question({ key: "k2" }))!;
    const restarted = createExternalApprovals({ store: f.store as never });
    expect(restarted.adopt(question(), earlier)).toBe(true);
    expect(restarted.dismissStale("t1")).toBe(1);
    expect(f.cardOf("t1", earlier.messageId).dismissed).toBeUndefined();
    expect(f.cardOf("t1", stray.messageId)).toMatchObject({ dismissed: true });
  });
});
