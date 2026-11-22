import { failureOf, rpcCall, rpcPost, type RpcContext } from "./rpc.ts";
import {
  cursorParamsSchema,
  eventNotificationSchema,
  eventSchema,
  eventsListResultSchema,
  eventsPollResultSchema,
  streamErrorParamsSchema,
} from "./schemas.ts";
import { readSseFrames } from "./sse.ts";
import type { McpEvent, McpEventStreamEnd, McpEventStreamRequest, McpEventSubscription, McpEventType } from "./types.ts";

export interface EventLayer {
  listEvents(): Promise<McpEventType[]>;
  pollEvents(req: McpEventSubscription): Promise<{ events: McpEvent[]; cursor: string }>;
  streamEvents(req: McpEventStreamRequest): Promise<McpEventStreamEnd>;
}

function subscriptionParams(req: McpEventSubscription): Record<string, unknown> {
  return { name: req.name, cursor: req.cursor, ...(req.arguments ? { arguments: req.arguments } : {}) };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createEventLayer(rpc: RpcContext): EventLayer {
  return {
    async listEvents() {
      return eventsListResultSchema.parse(await rpcCall(rpc, "events/list", {})).events;
    },

    async pollEvents(req) {
      const { events, cursor } = eventsPollResultSchema.parse(await rpcCall(rpc, "events/poll", subscriptionParams(req)));
      return { events, cursor };
    },

    async streamEvents(req) {
      let last = req.cursor;
      const end = (reason: McpEventStreamEnd["reason"], error?: string): McpEventStreamEnd => ({
        cursor: last,
        reason,
        ...(error === undefined ? {} : { error }),
      });
      if (req.signal.aborted) return end("aborted");
      try {
        const { response } = await rpcPost(rpc, "events/stream", subscriptionParams(req), { signal: req.signal, stream: true });
        if (!response.ok) throw await failureOf(response);
        if (!response.body) return end("closed");
        if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return end("error", (await failureOf(response)).message);
        for await (const frame of readSseFrames(response.body)) {
          let message;
          try {
            message = eventNotificationSchema.safeParse(JSON.parse(frame.data));
          } catch {
            continue;
          }
          if (!message.success) continue;
          const { method, params } = message.data;
          if (method === "notifications/events/active") {
            const cursor = cursorParamsSchema.safeParse(params).data?.cursor;
            if (cursor !== undefined) last = cursor;
          } else if (method === "notifications/events/event") {
            const event = eventSchema.safeParse(params);
            if (!event.success) continue;
            req.onEvent(event.data);
            if (event.data.cursor !== undefined) last = event.data.cursor;
          } else if (method === "notifications/events/heartbeat") {
            const cursor = cursorParamsSchema.safeParse(params).data?.cursor;
            if (cursor !== undefined) {
              last = cursor;
              req.onHeartbeat?.(cursor);
            }
          } else if (method === "notifications/events/error") {
            return end("error", streamErrorParamsSchema.safeParse(params).data?.error?.message ?? "the stream reported an error");
          }
        }
        return end(req.signal.aborted ? "aborted" : "closed");
      } catch (error) {
        if (req.signal.aborted || isAbort(error)) return end("aborted");
        return end("error", error instanceof Error ? error.message : "the stream failed");
      }
    },
  };
}
