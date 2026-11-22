import { timingSafeEqual } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import type { ConnectorDefinition } from "../ports.ts";
import type { ContractView } from "../connectors/registry.ts";
import { OMB_EVENT_TYPES, payloadSchemaOf, type OmbEventV1 } from "../contract/omb-event.v1.ts";
import { createOmbEventValidator, type ConformanceResult, type ConnectorDeclaration } from "../contract/validate.ts";
import { parseJson } from "../../schema.ts";

/** A type that only tests register; the shipped contract keeps the `pr.*` types. */
export const TEST_TYPE = "chat.message.posted";
const TEST_PAYLOAD = {
  type: "object",
  required: ["text", "author"],
  properties: { text: { type: "string" }, author: { type: "string" } },
} as const;

export function withTestTypes(): {
  validator: ReturnType<typeof createOmbEventValidator>;
  contract: ContractView;
} {
  const base = createOmbEventValidator();
  const payload = new Ajv2020({ strict: true }).compile(TEST_PAYLOAD);

  function run(value: unknown, declaration?: ConnectorDeclaration): ConformanceResult {
    const result = declaration ? base.checkFor(value, declaration) : base.check(value);
    if (result.ok || result.reason !== `unknown type ${TEST_TYPE}`) return result;
    const event = value as OmbEventV1;
    const fail = (reason: string): ConformanceResult => ({ ok: false, id: event.id, reason });
    if (!payload(event.data)) return fail(`type ${TEST_TYPE}: ${payload.errors?.[0]?.instancePath || "/"} ${payload.errors?.[0]?.message ?? "is not valid"}`);
    if (declaration && !declaration.emits.includes(TEST_TYPE)) return fail(`type ${TEST_TYPE} is not emitted by ${declaration.id}`);
    if (declaration && event.source.connector !== declaration.id) return fail(`source.connector is ${event.source.connector}, expected ${declaration.id}`);
    if (event.subject.kind !== "thread") return fail(`type ${TEST_TYPE} needs a thread subject`);
    return { ok: true, event };
  }

  return {
    validator: { check: value => run(value), checkFor: (value, declaration) => run(value, declaration) },
    contract: {
      types: { ...OMB_EVENT_TYPES, [TEST_TYPE]: { subjectKind: "thread", title: "Message posted", description: "A message was posted in a thread." } },
      payloadSchemaOf: type => (type === TEST_TYPE ? { ...TEST_PAYLOAD } : payloadSchemaOf(type)),
    },
  };
}

export function chatEvent(connector: string, id: string, text = "hello"): OmbEventV1 {
  return {
    v: 1, id, source: { connector }, type: TEST_TYPE, occurredAt: "2026-11-22T03:00:00Z",
    subject: { kind: "thread", id: "thread-1", label: "General" },
    data: { text, author: "alice" },
  };
}

const settingsSchema = z.strictObject({});
type NoSettings = z.output<typeof settingsSchema>;

/** An inbound connector with bearer auth whose body is one contract event. */
export const testHook: ConnectorDefinition<NoSettings> = {
  id: "test-hook",
  title: "Test hook",
  description: "An inbound connector that only tests register.",
  icon: { glyph: "webhook" },
  emits: [TEST_TYPE],
  delivery: "inbound-http",
  settingsSchema,
  secret: { required: true, defaultName: "TEST_HOOK_SECRET" },
  defaultInstance: { enabled: false, settings: {} },
  inbound: {
    precheck(req, ctx) {
      const given = Buffer.from(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "");
      if (ctx.key && given.length === ctx.key.length && timingSafeEqual(given, ctx.key)) return { ok: true };
      return { ok: false, status: 401, reason: "bad bearer token", signatureFailure: true };
    },
    verify: () => ({ ok: true }),
    parse(body) {
      try {
        return { ok: true, items: [parseJson(body.toString("utf8"))] };
      } catch {
        return { ok: false, status: 400, reason: "body is not JSON" };
      }
    },
    respond: ({ accepted }) => ({ status: 202, body: { taken: accepted.length } }),
  },
};

/** A subscription connector that emits the queued events once, remembers the last id as its cursor, and runs until it is stopped. */
export function createTestFeed(queue: readonly OmbEventV1[]): ConnectorDefinition<NoSettings> {
  return {
    id: "test-feed",
    title: "Test feed",
    description: "A subscription connector that only tests register.",
    icon: { glyph: "rss" },
    emits: [TEST_TYPE],
    delivery: "subscription",
    settingsSchema,
    secret: { required: false, defaultName: "TEST_FEED_SECRET" },
    defaultInstance: { enabled: false, settings: {} },
    async subscribe(ctx) {
      const cursor = ctx.cursor();
      const pending = queue.slice(cursor === null ? 0 : queue.findIndex(event => event.id === cursor) + 1);
      if (pending.length > 0) {
        ctx.emit([...pending]);
        ctx.saveCursor(pending[pending.length - 1]!.id);
      }
      ctx.report({ ok: true });
      await new Promise<void>(resolve => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}
