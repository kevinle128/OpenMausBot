import { describe, expect, it } from "vitest";
import type { SubscriptionContext } from "../ports.ts";
import { chatEvent, createTestFeed } from "./fake-connectors.ts";

function context(abort: AbortController, cursor: string | null) {
  const emitted: unknown[][] = [];
  const saved: string[] = [];
  const ctx: SubscriptionContext<Record<string, never>> = {
    instance: "test-feed", settings: {}, key: null, signal: abort.signal, now: () => 0,
    emit: events => { emitted.push(events); }, cursor: () => cursor, saveCursor: value => { saved.push(value); }, report: () => {},
  };
  return { ctx, emitted, saved };
}

describe("fake subscription connector", () => {
  const queue = [chatEvent("test-feed", "a"), chatEvent("test-feed", "b"), chatEvent("test-feed", "c")];

  it("emits the queued events, saves the last id as the cursor and stops on abort", async () => {
    const abort = new AbortController();
    const { ctx, emitted, saved } = context(abort, null);
    const running = createTestFeed(queue).subscribe!(ctx);
    abort.abort();
    await running;
    expect(emitted).toEqual([queue]);
    expect(saved).toEqual(["c"]);
  });

  it("resumes after the saved cursor", async () => {
    const abort = new AbortController();
    abort.abort();
    const { ctx, emitted, saved } = context(abort, "a");
    await createTestFeed(queue).subscribe!(ctx);
    expect(emitted).toEqual([queue.slice(1)]);
    expect(saved).toEqual(["c"]);
  });
});
