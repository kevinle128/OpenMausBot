import { z } from "zod";
import type { ConnectorDefinition, InboundContext, InboundRequest, Verdict } from "../ports.ts";
import { checkBatch } from "../contract/validate.ts";
import { parseJson } from "../../schema.ts";
import { checkSignatureHeaders, verifyBatchSignature } from "../signature.ts";

export const hubSettingsSchema = z.strictObject({ toleranceSeconds: z.number().int().min(30).max(900).default(300) });
export type HubSettings = z.output<typeof hubSettingsSchema>;

function bad(reason: string): Verdict {
  return { ok: false, status: 401, reason, signatureFailure: true };
}

const precheck = (req: InboundRequest, ctx: InboundContext<HubSettings>): Verdict => {
  const result = checkSignatureHeaders(req.headers["x-omb-timestamp"], req.headers["x-omb-signature"], ctx.now, ctx.settings.toleranceSeconds);
  return result.ok ? { ok: true } : bad(result.reason);
};

/** Transport and auth of the hub's signed batch `{ v: 1, events: [...] }`; the answer is the hub's `omb` sink answer. */
export const hubDelivery: Pick<ConnectorDefinition<HubSettings>, "delivery" | "settingsSchema" | "inbound"> = {
  delivery: "inbound-http",
  settingsSchema: hubSettingsSchema,
  inbound: {
    precheck,
    verify(req, ctx): Verdict {
      if (!ctx.key) return bad("no key");
      const result = verifyBatchSignature({
        key: ctx.key, timestamp: req.headers["x-omb-timestamp"], signature: req.headers["x-omb-signature"],
        body: req.body, nowMs: ctx.now, toleranceSeconds: ctx.settings.toleranceSeconds,
      });
      return result.ok ? { ok: true } : bad(result.reason);
    },
    parse(body) {
      let value: unknown;
      try {
        value = parseJson(body.toString("utf8"));
      } catch {
        return { ok: false, status: 400, reason: "body is not JSON" };
      }
      const batch = checkBatch(value);
      return batch.ok ? { ok: true, items: batch.events } : { ok: false, status: 400, reason: batch.reason };
    },
    respond: ({ accepted, rejected }) => ({
      status: 200,
      body: { acked: accepted, rejected: rejected.flatMap(item => (item.id ? [item.id] : [])) },
    }),
  },
};

export const HUB_EMITS: string[] = ["pr.opened", "pr.pushed", "pr.ci.finished", "pr.review.finished", "pr.comment.created", "pr.conflict.detected", "pr.merged", "pr.closed"];
