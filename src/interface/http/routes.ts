import { Hono, type Context } from 'hono';
import type { FeedbackUseCases } from '../../application/use-cases/feedback-use-cases.js';
import { FeedbackNotFoundError } from '../../domain/errors.js';
import type { FeedbackItem, FeedbackReply, PointsEntry } from '../../domain/types.js';
import { actorMiddleware, type ContextVariables } from './middlewares.js';
import { adjustSchema, listAllSchema, listMineSchema, parseBody, parseWith, replySchema, respondSchema, submitSchema } from './validators.js';

export interface AppDependencies {
  useCases: { feedback: FeedbackUseCases };
  corsOrigin: string;
}

type Ctx = Context<{ Variables: ContextVariables }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Un id que no es uuid se trata como «no existe» (404), igual que uno ajeno. */
const itemId = (c: Ctx) => {
  const id = c.req.param('itemId') ?? '';
  if (!UUID.test(id)) throw new FeedbackNotFoundError();
  return id.toLowerCase();
};

/** Lo que ve cada lado: la persona, lo suyo; el dueño, además quién lo mandó y de qué empresa. */
export function itemDto(i: FeedbackItem, platform: boolean) {
  return {
    id: i.id,
    kind: i.kind,
    title: i.title,
    body: i.body,
    status: i.status,
    traceId: i.traceId,
    urlPath: i.urlPath,
    replyCount: i.replyCount,
    unread: platform ? i.unreadByPlatform : i.unreadByAuthor,
    lastActivityAt: i.lastActivityAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
    ...(platform
      ? { organizationId: i.organizationId, organizationName: i.organizationName, authorId: i.authorId, authorName: i.authorName, authorEmail: i.authorEmail }
      : {}),
  };
}
const replyDto = (r: FeedbackReply) => ({ id: r.id, fromPlatform: r.fromPlatform, authorId: r.authorId, body: r.body, createdAt: r.createdAt.toISOString() });
const entryDto = (e: PointsEntry) => ({ id: e.id, itemId: e.itemId, amount: e.amount, reason: e.reason, createdAt: e.createdAt.toISOString() });

export function healthRoutes(): Hono {
  const r = new Hono();
  r.get('/health', (c) => c.json({ status: 'ok' }));
  return r;
}

export function feedbackRoutes(deps: AppDependencies): Hono<{ Variables: ContextVariables }> {
  const { feedback } = deps.useCases;
  const r = new Hono<{ Variables: ContextVariables }>();
  r.use('/feedback', actorMiddleware());
  r.use('/feedback/*', actorMiddleware());

  // ── La persona ──
  r.post('/feedback', async (c) => c.json(itemDto(await feedback.submit(c.get('actor'), await parseBody(c, submitSchema)), false), 201));
  r.get('/feedback', async (c) => {
    const { items, nextCursor } = await feedback.listMine(c.get('actor'), parseWith(listMineSchema, c.req.query()));
    return c.json({ items: items.map((i) => itemDto(i, false)), nextCursor });
  });
  r.get('/feedback/unread', async (c) => c.json({ count: await feedback.unreadForAuthor(c.get('actor')) }));
  r.get('/feedback/points', async (c) => {
    const { balance, entries } = await feedback.myPoints(c.get('actor'));
    return c.json({ balance, entries: entries.map(entryDto) });
  });

  // ── El dueño de la plataforma (`feedback:manage`) ──
  r.get('/feedback/admin/items', async (c) => {
    const q = parseWith(listAllSchema, c.req.query());
    const { items, nextCursor } = await feedback.listAll(
      c.get('actor'),
      { status: q.status, kind: q.kind, organizationId: q.organizationId?.toLowerCase(), unread: q.unread === 'true', q: q.q || undefined },
      { cursor: q.cursor, limit: q.limit },
    );
    return c.json({ items: items.map((i) => itemDto(i, true)), nextCursor });
  });
  r.get('/feedback/admin/unread', async (c) => c.json({ count: await feedback.unreadForPlatform(c.get('actor')) }));
  r.get('/feedback/admin/suggestions', async (c) => c.json({ points: feedback.suggestions(c.get('actor')) }));
  r.get('/feedback/admin/points', async (c) => c.json({ items: await feedback.balances(c.get('actor')) }));
  r.post('/feedback/admin/points', async (c) => c.json(entryDto(await feedback.adjustPoints(c.get('actor'), await parseBody(c, adjustSchema))), 201));
  r.get('/feedback/admin/items/:itemId', async (c) => {
    const d = await feedback.getAsPlatform(c.get('actor'), itemId(c));
    return c.json({ item: itemDto(d.item, true), replies: d.replies.map(replyDto), points: d.points.map(entryDto) });
  });
  r.post('/feedback/admin/items/:itemId/respond', async (c) => {
    const d = await feedback.respond(c.get('actor'), itemId(c), await parseBody(c, respondSchema));
    return c.json({ item: itemDto(d.item, true), replies: d.replies.map(replyDto), points: d.points.map(entryDto) });
  });

  // Después de las de `/feedback/admin/*` y las fijas: `:itemId` no debe tragarse «admin», «points» ni «unread».
  r.get('/feedback/:itemId', async (c) => {
    const d = await feedback.get(c.get('actor'), itemId(c));
    return c.json({ item: itemDto(d.item, false), replies: d.replies.map(replyDto), points: d.points.map(entryDto) });
  });
  r.post('/feedback/:itemId/replies', async (c) => {
    const { body } = await parseBody(c, replySchema);
    return c.json(replyDto(await feedback.reply(c.get('actor'), itemId(c), body)), 201);
  });
  return r;
}
