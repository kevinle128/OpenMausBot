import { afterEach, describe, expect, it } from "vitest";
import { buildPayload } from "./payloads.ts";
import { ctxFor, DEFAULT_PR_KEY, ev, SHA_A } from "./testing/builders.ts";
import { makeHarness, type Harness } from "./testing/pm-harness.ts";
import type { LedgerEntry } from "./types.ts";

let h: Harness;
afterEach(() => h.close());

function askAbout(entry: LedgerEntry) {
  h = makeHarness();
  h.send(ev.opened({ head: SHA_A }));
  return buildPayload({
    action: { do: "AskPerson", params: { kind: "command_failed" } }, params: { kind: "command_failed" }, record: h.record(), before: null,
    trigger: { name: "command.finished", entry, seq: 9 }, ctx: ctxFor(), prKey: DEFAULT_PR_KEY,
  });
}

describe("question payloads", () => {
  it("carries the failed command and its reason when a command finished with a failure", () => {
    const failed: LedgerEntry = {
      type: "command.finished", commandId: "c1", command: "Merge", payload: { type: "Merge", method: "squash", expectedHeadSha: SHA_A, deleteBranch: true },
      result: { outcome: "failed", reason: "branch protection refused", retryable: false },
    };
    expect(askAbout(failed)).toMatchObject({ type: "AskPerson", kind: "command_failed", about: { command: "Merge", reason: "branch protection refused" } });
  });

  it("leaves the failed command empty for any other trigger", () => {
    expect(askAbout({ type: "person.answered", decisionId: "d", answer: "yes" })).toMatchObject({ type: "AskPerson", about: null });
  });
});
