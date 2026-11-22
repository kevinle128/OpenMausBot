import { describe, expect, it } from "vitest";
import { PR_EVENT_TRIGGERS } from "../types.ts";
import { invalidFixtures, validFixtures } from "./conformance/index.ts";
import { CONTRACT_EVENT_SCHEMA, CONTRACT_EVENT_TYPES, TYPE_PATTERN, payloadSchemaOf } from "./omb-event.v1.ts";
import { checkBatch, createOmbEventValidator } from "./validate.ts";

const validator = createOmbEventValidator();
const github = { id: "github-event", emits: Object.keys(CONTRACT_EVENT_TYPES), subjectRule: { forge: "github" } };

function fixture(type: string): Record<string, any> {
  const found = validFixtures().find(item => item.type === type);
  if (!found) throw new Error(`no valid fixture for ${type}`);
  return found.event as Record<string, any>;
}

describe("OMB event validator", () => {
  it("accepts every valid fixture", () => {
    for (const { type, event } of validFixtures()) {
      const result = validator.check(event);
      expect(result.ok ? "ok" : `${type}: ${result.reason}`).toBe("ok");
      expect(validator.checkFor(event, github).ok).toBe(true);
    }
  });

  it("rejects every invalid fixture with its expected reason", () => {
    expect(invalidFixtures().length).toBeGreaterThanOrEqual(8);
    for (const { name, event, reason } of invalidFixtures()) {
      const result = validator.check(event);
      expect(result.ok, name).toBe(false);
      expect(result.ok ? null : result.reason, name).toBe(reason);
    }
  });

  it("names the event id of a rejected item when it has one", () => {
    const named = invalidFixtures().find(item => item.name === "version-2");
    const missing = invalidFixtures().find(item => item.name === "missing-id");
    expect(validator.check(named?.event)).toMatchObject({ ok: false, id: "github:delivery-0003:0" });
    expect(validator.check(missing?.event)).toMatchObject({ ok: false, id: null });
  });

  it("rejects the pr-event v1 shape the hub sends today", () => {
    const hub = invalidFixtures().find(item => item.name === "pr-event-v1-item");
    const result = validator.check(hub?.event);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/^envelope: /);
  });

  it("rejects a type that the connector does not emit, a wrong source connector and a broken subject rule", () => {
    const merged = fixture("pr.merged");
    expect(validator.checkFor(merged, { ...github, emits: ["pr.opened"] })).toMatchObject({ ok: false, reason: "type pr.merged is not emitted by github-event" });
    expect(validator.checkFor(merged, { ...github, id: "gitlab-event" })).toMatchObject({ ok: false, reason: "source.connector is github-event, expected gitlab-event" });
    expect(validator.checkFor(merged, { ...github, subjectRule: { forge: "gitlab" } })).toMatchObject({ ok: false, reason: "subject.forge is github, expected gitlab" });
    expect(validator.checkFor(merged, github).ok).toBe(true);
  });

  it("rejects a pr type on a generic subject and accepts a generic subject on an unknown domain only when the type is defined", () => {
    const generic = { ...fixture("pr.opened"), subject: { kind: "thread", id: "t-1", label: "Release chat" } };
    expect(validator.check(generic)).toMatchObject({ ok: false, reason: "type pr.opened needs a pr subject" });
    expect(validator.check({ ...generic, type: "chat.message.posted" })).toMatchObject({ ok: false, reason: "unknown type chat.message.posted" });
  });

  it("ignores fields it does not know", () => {
    const event = fixture("pr.ci.finished");
    const extended = { ...event, futureField: { a: 1 }, data: { ...event.data, futureData: true, check: { ...event.data.check, futureCheck: "x" } } };
    expect(validator.check(extended).ok).toBe(true);
  });

  it("does not read a prototype property as a type", () => {
    const event = { ...fixture("pr.opened"), type: "constructor.name" };
    expect(validator.check(event)).toMatchObject({ ok: false, reason: "unknown type constructor.name" });
  });

  it("lists the same types in the schema, the TypeScript table and the trigger list", () => {
    const schemaTypes = Object.keys((CONTRACT_EVENT_SCHEMA.$defs as { payloads: object }).payloads).sort();
    expect(schemaTypes).toEqual(Object.keys(CONTRACT_EVENT_TYPES).sort());
    expect([...PR_EVENT_TRIGGERS].sort()).toEqual(schemaTypes);
    for (const type of schemaTypes) {
      expect(TYPE_PATTERN.test(type)).toBe(true);
      expect(payloadSchemaOf(type)).not.toBeNull();
    }
    expect(payloadSchemaOf("pr.unknown")).toBeNull();
  });

  it("refuses a batch without v 1 or without an events array", () => {
    expect(checkBatch({ v: 1, events: [] })).toEqual({ ok: true, events: [] });
    expect(checkBatch({ v: 2, events: [] }).ok).toBe(false);
    expect(checkBatch({ events: [] }).ok).toBe(false);
    expect(checkBatch({ v: 1 }).ok).toBe(false);
    expect(checkBatch({ v: 1, events: {} }).ok).toBe(false);
    expect(checkBatch(null).ok).toBe(false);
    expect(checkBatch([]).ok).toBe(false);
  });
});
