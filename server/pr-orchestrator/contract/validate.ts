import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { DOMAIN_SUBJECT, OMB_EVENT_SCHEMA, payloadSchemaOf, type OmbEventV1 } from "./omb-event.v1.ts";

export type ConformanceResult = { ok: true; event: OmbEventV1 } | { ok: false; id: string | null; reason: string };

export interface ConnectorDeclaration {
  id: string;
  emits: readonly string[];
  subjectRule?: Record<string, string>;
}

const SCHEMA_ID = String(OMB_EVENT_SCHEMA.$id);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A delivery is `{ v: 1, events: [...] }`; the items are checked one by one afterwards. */
export function checkBatch(value: unknown): { ok: true; events: unknown[] } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "batch is not an object" };
  if (value.v !== 1) return { ok: false, reason: "batch v must be 1" };
  if (!Array.isArray(value.events)) return { ok: false, reason: "batch events must be an array" };
  return { ok: true, events: value.events };
}

function describeError(errors: ErrorObject[] | null | undefined): string {
  const error = errors?.[0];
  if (!error) return "does not conform";
  const message = error.keyword === "enum" ? `must be one of ${(error.params.allowedValues as unknown[]).join(", ")}` : error.message ?? "is not valid";
  return `${error.instancePath || "/"} ${message}`;
}

export function createOmbEventValidator(): {
  /** Envelope, then the payload of its type, then the domain-to-subject rule. */
  check(value: unknown): ConformanceResult;
  /** The same, plus the connector's declaration: type in emits, source.connector === definitionId, subjectRule. */
  checkFor(value: unknown, declaration: ConnectorDeclaration): ConformanceResult;
} {
  const ajv = new Ajv2020({
    strict: true, strictTypes: false, strictRequired: false, allErrors: false, coerceTypes: false,
    useDefaults: false, removeAdditional: false, validateFormats: true, ownProperties: true,
  });
  formats.default(ajv);
  const envelope = ajv.compile(OMB_EVENT_SCHEMA);
  const payloadValidators = new Map<string, ValidateFunction>();

  /** Caches known types only: an unknown type string from a sender must not grow the map. */
  function payloadValidator(type: string): ValidateFunction | null {
    const cached = payloadValidators.get(type);
    if (cached !== undefined) return cached;
    if (!payloadSchemaOf(type)) return null;
    const compiled = ajv.compile({ $ref: `${SCHEMA_ID}#/$defs/payloads/${type}` });
    payloadValidators.set(type, compiled);
    return compiled;
  }

  function run(value: unknown, declaration?: ConnectorDeclaration): ConformanceResult {
    const id = isRecord(value) && typeof value.id === "string" && value.id !== "" ? value.id : null;
    const fail = (reason: string): ConformanceResult => ({ ok: false, id, reason });
    if (!envelope(value)) return fail(`envelope: ${describeError(envelope.errors)}`);
    const event = value as unknown as OmbEventV1;
    const payload = payloadValidator(event.type);
    if (!payload) return fail(`unknown type ${event.type}`);
    if (!payload(event.data)) return fail(`type ${event.type}: ${describeError(payload.errors)}`);
    if (declaration) {
      if (!declaration.emits.includes(event.type)) return fail(`type ${event.type} is not emitted by ${declaration.id}`);
      if (event.source.connector !== declaration.id) return fail(`source.connector is ${event.source.connector}, expected ${declaration.id}`);
    }
    const subjectKind = Object.hasOwn(DOMAIN_SUBJECT, event.type.split(".")[0]) ? DOMAIN_SUBJECT[event.type.split(".")[0]] : null;
    if (subjectKind && event.subject.kind !== subjectKind) return fail(`type ${event.type} needs a ${subjectKind} subject`);
    for (const [field, expected] of Object.entries(declaration?.subjectRule ?? {})) {
      const actual = (event.subject as unknown as Record<string, unknown>)[field];
      if (actual !== expected) return fail(`subject.${field} is ${String(actual)}, expected ${expected}`);
    }
    return { ok: true, event };
  }

  return { check: value => run(value), checkFor: (value, declaration) => run(value, declaration) };
}
