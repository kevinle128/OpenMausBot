import { describe, expect, it } from "vitest";
import { OMB_EVENT_TYPES } from "../omb-event.v1.ts";
import { checkConformance, describeConnectorConformance, invalidFixtures, validFixtures, type DeliverResult } from "./index.ts";

describe("conformance fixtures", () => {
  it("gives every contract type a valid fixture", () => {
    expect(validFixtures().map(item => item.type).sort()).toEqual(Object.keys(OMB_EVENT_TYPES).sort());
  });

  it("labels every invalid fixture with a reason that the validator gives", () => {
    for (const fixture of invalidFixtures()) {
      const result = checkConformance(fixture.event);
      expect(result.ok ? "accepted" : result.reason, fixture.name).toBe(fixture.reason);
    }
  });
});

const fake = { id: "fake-hub", emits: ["pr.opened", "pr.merged"], subjectRule: { forge: "github" } };
const samples = validFixtures()
  .filter(item => fake.emits.includes(item.type))
  .map(item => ({ ...(item.event as object), source: { connector: fake.id } }));

describeConnectorConformance(fake, { samples });

describe("connector conformance with a delivery function", () => {
  const deliver = async (events: unknown[]): Promise<DeliverResult> => {
    const result: DeliverResult = { accepted: [], rejected: [] };
    for (const event of events) {
      const checked = checkConformance(event, fake);
      if (checked.ok) result.accepted.push(checked.event.id);
      else result.rejected.push({ id: checked.id, reason: checked.reason });
    }
    return result;
  };
  describeConnectorConformance(fake, { samples, deliver });
});

describe("connector conformance with an injected contract", () => {
  const extra = {
    validator: {
      check: (value: unknown) => checkConformance(value),
      checkFor: (value: unknown, declaration: Parameters<typeof checkConformance>[1]) => {
        const event = value as { type?: string; id: string };
        if (event.type === "chat.message.posted") return { ok: true as const, event: value as never };
        return checkConformance(value, declaration);
      },
    },
    contract: { types: { ...OMB_EVENT_TYPES, "chat.message.posted": { subjectKind: "thread", title: "Posted", description: "A message." } } },
  };
  const chat = { id: "fake-chat", emits: ["chat.message.posted"] };
  const sample = { v: 1, id: "m1", source: { connector: "fake-chat" }, type: "chat.message.posted", occurredAt: "2026-11-22T03:00:00Z", subject: { kind: "thread", id: "t" }, data: {} };

  describeConnectorConformance(chat, { samples: [sample], contract: extra });

  it("does not know the extra type without the injected contract", () => {
    const result = checkConformance(sample);
    expect(result.ok ? "ok" : result.reason).toBe("unknown type chat.message.posted");
  });
});
