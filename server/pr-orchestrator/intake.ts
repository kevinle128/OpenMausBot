import type { IncomingMessage } from "node:http";
import type { ConnectorDefinition, InboundContext, InboundRequest, Verdict } from "./ports.ts";
import { createOmbEventValidator } from "./contract/validate.ts";
import { subjectKeyOf, type AcceptItem, type IntakeSink } from "./types.ts";
import { json, type IngressDoor } from "../webhook-ingress.ts";

export const EVENTS_PATH = /^\/events\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
/** The hub's `batchSize` for these connectors must stay at 50 or less. */
export const MAX_EVENTS_BODY_BYTES = 4 * 1024 * 1024;

export type IntakeOutcome = "accepted" | "duplicate" | "rejected" | "bad_signature" | "bad_request" | "error";
type Rejection = { id: string | null; reason: string };
type Validator = Pick<ReturnType<typeof createOmbEventValidator>, "checkFor">;

export interface EventsDoorDeps {
  enabled(): boolean;
  /** Enabled instances only. */
  instance(id: string): { definition: ConnectorDefinition; settings: unknown; secretName: string | null } | null;
  /** The Vault value of a secret; never logged. */
  key(secretName: string): Buffer | null;
  validator?: Validator;
  sink: IntakeSink;
  /** One entry per outcome of a request; never holds a body, a header or a key. */
  log(entry: { connector: string; outcome: IntakeOutcome; count: number; detail?: string }): void;
  claimRequest?: () => () => void;
  now?: () => number;
  logLine(line: string): void;
}

export async function readBodyBuffer(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) throw Object.assign(new Error("Body is too large"), { status: 413 });
      chunks.push(buffer);
    }
  } catch (error) {
    if ((error as { status?: number }).status === 413) throw error;
    throw Object.assign(new Error("Could not read the body"), { status: 400 });
  }
  return Buffer.concat(chunks, bytes);
}

/** Checks every item against the contract and the connector's declaration; the same check serves every delivery kind. */
export function conformItems(
  items: unknown[], instance: string, definition: ConnectorDefinition, validator: Validator,
): { accepted: AcceptItem[]; rejected: Rejection[] } {
  const accepted: AcceptItem[] = [];
  const rejected: Rejection[] = [];
  for (const item of items) {
    const result = validator.checkFor(item, definition);
    if (!result.ok) {
      rejected.push({ id: result.id, reason: result.reason });
      continue;
    }
    accepted.push({
      event: { ...result.event, connector: instance, key: `${instance}:${result.event.id}`, subjectKey: subjectKeyOf(instance, result.event), rawRef: null },
      raw: JSON.stringify(item),
    });
  }
  return { accepted, rejected };
}

function headersOf(req: IncomingMessage): InboundRequest["headers"] {
  const headers: InboundRequest["headers"] = {};
  for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  return headers;
}

function firstReasons(rejected: Rejection[]): string {
  return [...new Set(rejected.map(item => item.reason))].slice(0, 3).join("; ");
}

export function createEventsDoor(deps: EventsDoorDeps): IngressDoor {
  const validator = deps.validator ?? createOmbEventValidator();
  const now = deps.now ?? Date.now;

  return async (req, res, url) => {
    const match = EVENTS_PATH.exec(url.pathname);
    if (!match || !deps.enabled()) return false;
    const instanceId = match[1]!;
    const instance = deps.instance(instanceId);
    if (!instance || instance.definition.delivery !== "inbound-http" || !instance.definition.inbound) return false;
    const { definition } = instance;
    const inbound = definition.inbound!;

    if (req.method !== "POST") {
      json(res, 405, { error: "Events are sent with POST" });
      return true;
    }
    let release: (() => void) | undefined;
    try {
      release = deps.claimRequest?.();
    } catch (error) {
      json(res, 503, { error: error instanceof Error ? error.message : "Try again soon" });
      return true;
    }
    const answer = (status: number, body: Parameters<typeof json>[2], outcome: IntakeOutcome, detail?: string, count = 1) => {
      deps.log({ connector: instanceId, outcome, count, ...(detail ? { detail } : {}) });
      json(res, status, body);
    };
    const refuse = (verdict: Extract<Verdict, { ok: false }>) =>
      answer(verdict.status, { error: verdict.reason }, verdict.signatureFailure ? "bad_signature" : "bad_request", verdict.reason);

    try {
      const settings = definition.settingsSchema.safeParse(instance.settings ?? {});
      if (!settings.success) {
        answer(503, { error: "The connector's settings are not valid" }, "error", "the connector's settings are not valid");
        return true;
      }
      const key = deps.key(instanceId);
      const context: InboundContext<unknown> = { instance: instanceId, settings: settings.data, key, now: now() };
      const request: InboundRequest = { method: req.method, headers: headersOf(req) };

      // Before the precheck: a header check against a missing key would answer 401 and count a signature failure.
      if (definition.secret.required && !key) {
        answer(503, { error: "The connector's secret is not saved" }, "error", "the connector's secret is not saved");
        return true;
      }
      const early = inbound.precheck?.(request, context);
      if (early && !early.ok) { refuse(early); return true; }

      let body: Buffer;
      try {
        body = await readBodyBuffer(req, MAX_EVENTS_BODY_BYTES);
      } catch (error) {
        const status = (error as { status?: number }).status === 413 ? 413 : 400;
        answer(status, { error: status === 413 ? "Body is too large" : "Could not read the body" }, "bad_request", status === 413 ? "body over the limit" : "unreadable body");
        return true;
      }
      const verdict = inbound.verify({ ...request, body }, context);
      if (!verdict.ok) { refuse(verdict); return true; }
      const parsed = inbound.parse(body, context);
      if (!parsed.ok) {
        answer(parsed.status, { error: parsed.reason }, "bad_request", parsed.reason);
        return true;
      }

      const { accepted, rejected } = conformItems(parsed.items, instanceId, definition, validator);
      let result = { stored: 0, duplicates: 0 };
      if (accepted.length > 0) {
        try {
          result = deps.sink.accept(accepted, now());
        } catch (error) {
          deps.logLine(`[pr-orchestrator] ${instanceId}: the store could not take a batch (${error instanceof Error ? error.message : "unknown error"})`);
          answer(503, { error: "Could not store the batch" }, "error", "the store could not take the batch", accepted.length);
          return true;
        }
      }
      if (result.stored > 0) deps.log({ connector: instanceId, outcome: "accepted", count: result.stored });
      if (result.duplicates > 0) deps.log({ connector: instanceId, outcome: "duplicate", count: result.duplicates });
      if (rejected.length > 0) deps.log({ connector: instanceId, outcome: "rejected", count: rejected.length, detail: firstReasons(rejected) });

      const reply = inbound.respond({ accepted: [...new Set(accepted.map(item => item.event.id))], rejected });
      json(res, reply.status, reply.body);
      return true;
    } catch (error) {
      deps.logLine(`[pr-orchestrator] ${instanceId}: the door failed (${error instanceof Error ? error.message : "unknown error"})`);
      answer(500, { error: "The door failed" }, "error", "the door failed");
      return true;
    } finally {
      release?.();
    }
  };
}
