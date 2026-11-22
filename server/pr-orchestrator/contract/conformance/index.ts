import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConnectorDefinition } from "../../ports.ts";
import type { ContractView } from "../../connectors/registry.ts";
import { CONTRACT_EVENT_TYPES } from "../omb-event.v1.ts";
import { createOmbEventValidator, type ConformanceResult, type ConnectorDeclaration } from "../validate.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const validator = createOmbEventValidator();

/** A contract that adds event types to the shipped one, for a connector that only a test registers. */
export interface InjectedContract {
  validator: Pick<ReturnType<typeof createOmbEventValidator>, "check" | "checkFor">;
  contract: Pick<ContractView, "types">;
}

export type DeliverResult = { accepted: string[]; rejected: Array<{ id: string | null; reason: string }> };
export interface InvalidFixture { name: string; event: unknown; reason: string }

/** The intake's validator: the envelope, the payload of the type and the subject rule, plus the connector's declaration when given. */
export function checkConformance(event: unknown, declaration?: ConnectorDeclaration, injected?: InjectedContract["validator"]): ConformanceResult {
  const used = injected ?? validator;
  return declaration ? used.checkFor(event, declaration) : used.check(event);
}

function readJson(directory: string, file: string): unknown {
  return JSON.parse(readFileSync(new URL(`${directory}/${file}`, FIXTURES), "utf8"));
}

function jsonFiles(directory: string): string[] {
  return readdirSync(new URL(`${directory}/`, FIXTURES)).filter(file => file.endsWith(".json")).sort();
}

/** One complete event per contract type, in the shape that the contract defines. */
export function validFixtures(): Array<{ type: string; event: unknown }> {
  return jsonFiles("valid").map(file => ({ type: file.replace(/\.json$/, ""), event: readJson("valid", file) }));
}

/** Events that break the contract, each with the reason that the validator gives. */
export function invalidFixtures(): InvalidFixture[] {
  return jsonFiles("invalid").map(file => {
    const { event, reason } = readJson("invalid", file) as { event: unknown; reason: string };
    return { name: file.replace(/\.json$/, ""), event, reason };
  });
}

/** Renames a well-formed source only: a fixture that breaks source itself must reach the connector broken. */
function asConnector(event: unknown, connector: string): unknown {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return event;
  const source = (event as { source?: unknown }).source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) return event;
  const current = (source as { connector?: unknown }).connector;
  if (typeof current !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(current)) return event;
  return { ...event, source: { ...source, connector } };
}

/**
 * Registers the conformance tests of one connector. `samples` are events that the connector would deliver.
 * With `deliver`, the suite also sends the samples and every invalid fixture through the connector's intake.
 * With `contract`, the connector may emit the extra types of that contract and its samples are checked by its validator;
 * without it, the shipped contract applies.
 */
export function describeConnectorConformance(
  definition: Pick<ConnectorDefinition, "id" | "emits" | "subjectRule">,
  opts: { samples: unknown[]; deliver?: (events: unknown[]) => Promise<DeliverResult>; contract?: InjectedContract },
): void {
  const declaration: ConnectorDeclaration = { id: definition.id, emits: definition.emits, subjectRule: definition.subjectRule };
  describe(`connector ${definition.id} conforms to the MausBot event contract`, () => {
    it("emits only types that the contract defines", () => {
      const types = opts.contract?.contract.types ?? CONTRACT_EVENT_TYPES;
      expect(definition.emits.filter(type => !Object.hasOwn(types, type))).toEqual([]);
    });

    it("produces samples that pass its own declaration", () => {
      expect(opts.samples.length).toBeGreaterThan(0);
      for (const sample of opts.samples) {
        const result = checkConformance(sample, declaration, opts.contract?.validator);
        expect(result.ok ? "ok" : result.reason).toBe("ok");
      }
    });

    const { deliver } = opts;
    if (!deliver) return;

    it("accepts a delivered batch of its samples", async () => {
      const ids = opts.samples.map(sample => (sample as { id: string }).id);
      const result = await deliver(opts.samples);
      expect(result.rejected).toEqual([]);
      expect([...result.accepted].sort()).toEqual([...new Set(ids)].sort());
    });

    const emitted = new Set(definition.emits);
    const reachable = (fixture: InvalidFixture) => !fixture.reason.includes(" needs a ") || emitted.has((fixture.event as { type: string }).type);
    for (const fixture of invalidFixtures().filter(reachable)) {
      it(`rejects the invalid fixture ${fixture.name} with its reason`, async () => {
        const result = await deliver([asConnector(fixture.event, definition.id)]);
        expect(result.accepted).toEqual([]);
        expect(result.rejected.map(item => item.reason)).toEqual([fixture.reason]);
      });
    }
  });
}
