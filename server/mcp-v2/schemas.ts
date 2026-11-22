import { z } from "zod";

const object = z.record(z.string(), z.unknown());

export const taskStatusSchema = z.enum(["working", "input_required", "completed", "failed", "cancelled"]);

const inputRequestSchema = z.looseObject({
  method: z.string(),
  params: z.looseObject({
    mode: z.string().optional(),
    message: z.string().optional(),
    requestedSchema: object.optional(),
  }),
});

export const taskSchema = z.looseObject({
  taskId: z.string().min(1),
  status: taskStatusSchema,
  statusMessage: z.string().optional(),
  ttlMs: z.number().optional(),
  inputRequests: z.record(z.string(), inputRequestSchema).optional(),
  result: z.unknown().optional(),
});

export const anyResultSchema = z.looseObject({});

export const eventTypeSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  delivery: z.array(z.string()).default([]),
  inputSchema: object.optional(),
  payloadSchema: object.optional(),
});

export const eventSchema = z.looseObject({
  eventId: z.string(),
  name: z.string(),
  timestamp: z.string(),
  data: z.unknown(),
  cursor: z.string().optional(),
});

export const eventsListResultSchema = z.looseObject({ events: z.array(eventTypeSchema) });

export const eventsPollResultSchema = z.looseObject({ events: z.array(eventSchema), cursor: z.string() });

export const cursorParamsSchema = z.looseObject({ cursor: z.string().optional() });

export const eventNotificationSchema = z.looseObject({
  method: z.string(),
  params: z.looseObject({}).optional(),
});

export const streamErrorParamsSchema = z.looseObject({
  error: z.looseObject({ message: z.string().optional() }).optional(),
});
