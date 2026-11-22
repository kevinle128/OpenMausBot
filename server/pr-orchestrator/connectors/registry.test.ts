import { describe, expect, it } from "vitest";
import { CONTRACT_EVENT_TYPES, payloadSchemaOf } from "../contract/omb-event.v1.ts";
import type { ConnectorDefinition } from "../ports.ts";
import { TEST_TYPE, createTestFeed, testHook, withTestTypes } from "../testing/fake-connectors.ts";
import { BUILT_IN_CONNECTORS } from "./index.ts";
import { githubEvent } from "./github-event.ts";
import { createConnectorRegistry } from "./registry.ts";

const contract = withTestTypes().contract;
const as = (definition: unknown) => definition as ConnectorDefinition;

describe("connector registry", () => {
  it("refuses two definitions with the same id", () => {
    expect(() => createConnectorRegistry([as(githubEvent), as(githubEvent)])).toThrow(/duplicate connector id github-event/);
  });

  it("refuses an id that is not kebab-case", () => {
    expect(() => createConnectorRegistry([as({ ...githubEvent, id: "GitHub_Event" })])).toThrow(/kebab-case/);
  });

  it("refuses a connector that emits a type the contract does not define", () => {
    expect(() => createConnectorRegistry([as({ ...githubEvent, emits: ["pr.opened", "pr.reviewed"] })])).toThrow(/pr\.reviewed/);
    expect(() => createConnectorRegistry([as(testHook)])).toThrow(new RegExp(TEST_TYPE.replace(/\./g, "\\.")));
    expect(createConnectorRegistry([as(testHook)], contract).get("test-hook")).toBeDefined();
  });

  it("refuses an inbound connector without an inbound handler", () => {
    expect(() => createConnectorRegistry([as({ ...githubEvent, inbound: undefined })])).toThrow(/needs an inbound handler/);
  });

  it("refuses a subscription or poll connector without a subscribe function", () => {
    const feed = createTestFeed([]);
    for (const delivery of ["subscription", "poll"] as const) {
      expect(() => createConnectorRegistry([as({ ...feed, delivery, subscribe: undefined })], contract)).toThrow(/needs a subscribe function/);
    }
    expect(createConnectorRegistry([as(feed)], contract).list()).toHaveLength(1);
  });

  it("lists the GitHub Event types with the contract's payload schemas", () => {
    const registry = createConnectorRegistry(BUILT_IN_CONNECTORS as unknown as ConnectorDefinition[]);
    const types = registry.eventTypes("github-event");
    expect(types.map(entry => entry.type)).toEqual(Object.keys(CONTRACT_EVENT_TYPES));
    for (const entry of types) {
      expect(entry.payloadSchema).toEqual(payloadSchemaOf(entry.type));
      expect(entry.title).toBe(CONTRACT_EVENT_TYPES[entry.type as keyof typeof CONTRACT_EVENT_TYPES].title);
      expect(entry.subjectKind).toBe("pr");
    }
    expect(registry.eventTypes()).toHaveLength(16);
    expect(registry.eventTypes("nobody")).toEqual([]);
    expect(registry.list().map(definition => definition.id)).toEqual(["github-event", "gitlab-event"]);
  });
});
