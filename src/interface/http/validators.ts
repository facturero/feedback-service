import type { Context } from 'hono';
import { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';
import { FEEDBACK_KINDS, FEEDBACK_STATUSES, type FeedbackKind, type FeedbackStatus } from '../../domain/types.js';

const uuid = z.string().guid();
const limit = (def: number, max: number) => z.preprocess((v) => (v === undefined || v === '' ? def : Number(v)), z.number().int().min(1).max(max));
const kinds = z.enum(FEEDBACK_KINDS as unknown as [FeedbackKind, ...FeedbackKind[]]);
const statuses = z.enum(FEEDBACK_STATUSES as unknown as [FeedbackStatus, ...FeedbackStatus[]]);

// Los límites finos de texto los aplica el caso de uso (mensaje claro en español); aquí solo se corta lo absurdo.
export const submitSchema = z.object({
  kind: kinds,
  title: z.string().max(1000),
  body: z.string().max(20_000),
  organizationName: z.string().max(500).nullish(),
  traceId: z.string().max(200).nullish(),
  urlPath: z.string().max(2000).nullish(),
});

export const replySchema = z.object({ body: z.string().max(20_000) });

export const respondSchema = z.object({
  body: z.string().max(20_000).nullish(),
  status: statuses.optional(),
  points: z
    .object({ amount: z.number().int(), reason: z.string().max(1000).nullish(), idempotencyKey: z.string().min(1).max(200) })
    .nullish(),
});

export const adjustSchema = z.object({
  organizationId: uuid,
  amount: z.number().int(),
  reason: z.string().max(1000),
  idempotencyKey: z.string().min(1).max(200),
});

export const listMineSchema = z.object({ cursor: z.string().max(300).optional(), limit: limit(20, 50) });

export const listAllSchema = z.object({
  status: statuses.optional(),
  kind: kinds.optional(),
  organizationId: uuid.optional(),
  unread: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(300).optional(),
  limit: limit(30, 100),
});

export function parseWith<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationError(r.error.issues.map((i) => ({ field: i.path.join('.') || 'body', message: i.message })));
  return r.data;
}

export async function parseBody<T>(c: Context, schema: z.ZodType<T, unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError([{ field: 'body', message: 'El cuerpo no es JSON válido.' }]);
  }
  return parseWith(schema, raw);
}
