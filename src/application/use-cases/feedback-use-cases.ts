import { FeedbackNotFoundError, ForbiddenError, RateLimitedError, ValidationError } from '../../domain/errors.js';
import type { ActivityCursor, ItemFilters, OrganizationBalance, Repositories } from '../../domain/repositories.js';
import {
  isPlatform,
  MAX_BODY,
  MAX_REASON,
  MAX_TITLE,
  SUGGESTED_POINTS,
  type Actor,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackReply,
  type FeedbackStatus,
  type PointsEntry,
} from '../../domain/types.js';
import { itemCreatedEvent, pointsGrantedEvent, replyCreatedEvent, statusChangedEvent } from '../events.js';
import { inTransaction, type Clock, type IdGenerator, type PeopleDirectory, type UnitOfWorkGateway } from '../ports.js';

/** Tope anti-spam por persona (regla 8): en memoria, por instancia. Una ventana deslizante de una hora. */
export class SubmitRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = 10, private readonly windowMs = 3_600_000, private readonly clock: Clock = () => new Date()) {}

  take(userId: string): boolean {
    const now = this.clock().getTime();
    const recent = (this.hits.get(userId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(userId, recent);
    return true;
  }
}

export interface SubmitInput {
  kind: FeedbackKind;
  title: string;
  body: string;
  organizationName?: string | null;
  traceId?: string | null;
  urlPath?: string | null;
}

export interface RespondInput {
  body?: string | null;
  status?: FeedbackStatus;
  points?: { amount: number; reason?: string | null; idempotencyKey: string } | null;
}

export interface ItemDetail {
  item: FeedbackItem;
  replies: FeedbackReply[];
  points: PointsEntry[];
}

/** Texto de la persona: sin espacios sobrantes en los bordes y sin más de dos líneas en blanco seguidas. */
function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function requireText(field: string, value: string | null | undefined, max: number, label: string): string {
  const v = clean(value ?? '');
  if (!v) throw new ValidationError([{ field, message: `Escribe ${label}.` }]);
  if (v.length > max) throw new ValidationError([{ field, message: `Máximo ${max} caracteres.` }]);
  return v;
}

export function encodeCursor(c: ActivityCursor): string {
  return Buffer.from(`${c.lastActivityAt.toISOString()}|${c.id}`).toString('base64url');
}

export function decodeCursor(raw: string | undefined): ActivityCursor | undefined {
  if (!raw) return undefined;
  const [at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const lastActivityAt = new Date(at ?? '');
  if (!id || Number.isNaN(lastActivityAt.getTime())) throw new ValidationError([{ field: 'cursor', message: 'Cursor inválido.' }]);
  return { lastActivityAt, id };
}

/**
 * Buzón de comentarios, mejoras y problemas (IMPLEMENTATION.md). La persona manda y conversa con el dueño de la plataforma; el dueño
 * (`feedback:manage`) ve los de todas las empresas, responde, cambia el estado y da puntos de fidelidad a la empresa.
 */
export class FeedbackUseCases {
  constructor(
    private readonly gateway: UnitOfWorkGateway,
    private readonly repos: Repositories,
    private readonly people: PeopleDirectory,
    private readonly limiter: SubmitRateLimiter,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  // ── La persona ─────────────────────────────────────────────────────────────

  async submit(actor: Actor, input: SubmitInput): Promise<FeedbackItem> {
    const title = requireText('title', input.title, MAX_TITLE, 'un título');
    const body = requireText('body', input.body, MAX_BODY, 'qué pasó o qué propones');
    // Cupo aparte para los problemas: quien mandó muchas ideas en una hora igual puede reportar que algo se rompió.
    if (!this.limiter.take(`${actor.userId}:${input.kind === 'problem' ? 'problem' : 'idea'}`)) throw new RateLimitedError();
    // El nombre y el correo, del directorio de auth (regla 3); si no responde, el envío se guarda igual (lo importante es no perderlo).
    const contact = await this.people.contact(actor.organizationId, actor.userId).catch(() => null);
    const now = this.clock();
    const item: FeedbackItem = {
      id: this.ids(),
      organizationId: actor.organizationId,
      organizationName: clean(input.organizationName ?? '').slice(0, 160) || null,
      authorId: actor.userId,
      authorName: contact?.name ?? null,
      authorEmail: contact?.email ?? null,
      kind: input.kind,
      title,
      body,
      status: 'new',
      traceId: input.kind === 'problem' ? (input.traceId?.trim().slice(0, 64) || null) : null,
      urlPath: input.urlPath?.trim().slice(0, 300) || null,
      unreadByPlatform: true,
      unreadByAuthor: false,
      replyCount: 0,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await inTransaction(this.gateway, async (uow) => {
      await uow.items.insert(item);
      await uow.outbox.add(itemCreatedEvent(item));
    });
    return item;
  }

  async listMine(actor: Actor, q: { cursor?: string; limit: number }): Promise<{ items: FeedbackItem[]; nextCursor: string | null }> {
    return this.page((before, limit) => this.repos.items.listByAuthor(actor.organizationId, actor.userId, { before, limit }), q);
  }

  /** Uno mío (solo de quien lo escribió, en su empresa; cualquier otro: 404). Abrirlo lo marca leído por su lado. */
  async get(actor: Actor, id: string): Promise<ItemDetail> {
    const item = await this.repos.items.findById(id);
    if (!item || item.authorId !== actor.userId || item.organizationId !== actor.organizationId) throw new FeedbackNotFoundError();
    return this.detail(item, 'author');
  }

  /** Cualquiera, para el dueño de la plataforma. Abrirlo lo marca leído por el lado de la plataforma. */
  async getAsPlatform(actor: Actor, id: string): Promise<ItemDetail> {
    this.requirePlatform(actor);
    const item = await this.repos.items.findById(id);
    if (!item) throw new FeedbackNotFoundError();
    return this.detail(item, 'platform');
  }

  /** La persona contesta en su conversación (o el dueño, si escribe como persona en uno suyo). */
  async reply(actor: Actor, id: string, body: string): Promise<FeedbackReply> {
    const text = requireText('body', body, MAX_BODY, 'tu respuesta');
    return inTransaction(this.gateway, async (uow) => {
      const item = await uow.items.findByIdForUpdate(id);
      if (!item || item.authorId !== actor.userId || item.organizationId !== actor.organizationId) throw new FeedbackNotFoundError();
      // Por esta ruta (la de la persona) contesta su autora; el dueño responde por `respond`.
      return this.addReply(uow, item, actor, text, false);
    });
  }

  async unreadForAuthor(actor: Actor): Promise<number> {
    return this.repos.items.countUnreadByAuthor(actor.organizationId, actor.userId);
  }

  /** Saldo y movimientos de puntos de MI empresa (los puntos son de la empresa, decisión del dueño). */
  async myPoints(actor: Actor): Promise<{ balance: number; entries: PointsEntry[] }> {
    return {
      balance: await this.repos.points.balance(actor.organizationId),
      entries: await this.repos.points.listByOrganization(actor.organizationId, 100),
    };
  }

  // ── El dueño de la plataforma ──────────────────────────────────────────────

  async listAll(actor: Actor, filters: ItemFilters, q: { cursor?: string; limit: number }): Promise<{ items: FeedbackItem[]; nextCursor: string | null }> {
    this.requirePlatform(actor);
    return this.page((before, limit) => this.repos.items.listAll(filters, { before, limit }), q);
  }

  async unreadForPlatform(actor: Actor): Promise<number> {
    this.requirePlatform(actor);
    return this.repos.items.countUnreadByPlatform();
  }

  /**
   * Responder en una sola acción (regla 12): una respuesta, un cambio de estado y puntos a la empresa, cualquiera de las tres. Los
   * puntos son idempotentes por la clave del navegador: un doble clic (o un reintento tras un corte) no los da dos veces.
   */
  async respond(actor: Actor, id: string, input: RespondInput): Promise<ItemDetail> {
    this.requirePlatform(actor);
    const body = input.body ? requireText('body', input.body, MAX_BODY, 'la respuesta') : null;
    const points = input.points ?? null;
    if (points) {
      if (!Number.isInteger(points.amount) || points.amount <= 0 || points.amount > 100_000) {
        throw new ValidationError([{ field: 'points.amount', message: 'Los puntos por una mejora son un número entero mayor que cero.' }]);
      }
      if (!points.idempotencyKey?.trim()) throw new ValidationError([{ field: 'points.idempotencyKey', message: 'Falta la clave del movimiento.' }]);
    }
    if (!body && !input.status && !points) throw new ValidationError([{ field: 'body', message: 'Escribe una respuesta, cambia el estado o da puntos.' }]);

    await inTransaction(this.gateway, async (uow) => {
      const item = await uow.items.findByIdForUpdate(id);
      if (!item) throw new FeedbackNotFoundError();
      const now = this.clock();
      if (input.status && input.status !== item.status) {
        const previous = item.status;
        item.status = input.status;
        item.updatedAt = now;
        item.lastActivityAt = now;
        item.unreadByAuthor = true;
        item.unreadByPlatform = false;
        await uow.items.update(item);
        await uow.outbox.add(statusChangedEvent(item, previous, actor.userId, now));
      }
      if (body) await this.addReply(uow, item, actor, body, true);
      if (points) {
        const entry: PointsEntry = {
          id: this.ids(),
          organizationId: item.organizationId,
          itemId: item.id,
          amount: points.amount,
          reason: clean(points.reason ?? '').slice(0, MAX_REASON) || defaultReason(item),
          grantedBy: actor.userId,
          idempotencyKey: points.idempotencyKey.trim().slice(0, 64),
          createdAt: now,
        };
        if (await uow.points.insertIfAbsent(entry)) await uow.outbox.add(pointsGrantedEvent(entry, item));
      }
    });
    return this.getAsPlatform(actor, id);
  }

  async balances(actor: Actor): Promise<OrganizationBalance[]> {
    this.requirePlatform(actor);
    return this.repos.points.balances();
  }

  /** Ajuste manual (regla 10): sumar o restar puntos a una empresa con un motivo (canje futuro, corrección). */
  async adjustPoints(actor: Actor, input: { organizationId: string; amount: number; reason: string; idempotencyKey: string }): Promise<PointsEntry> {
    this.requirePlatform(actor);
    if (!Number.isInteger(input.amount) || input.amount === 0 || Math.abs(input.amount) > 1_000_000) {
      throw new ValidationError([{ field: 'amount', message: 'Un número entero distinto de cero.' }]);
    }
    const reason = requireText('reason', input.reason, MAX_REASON, 'el motivo');
    const entry: PointsEntry = {
      id: this.ids(),
      organizationId: input.organizationId.toLowerCase(),
      itemId: null,
      amount: input.amount,
      reason,
      grantedBy: actor.userId,
      idempotencyKey: input.idempotencyKey.trim().slice(0, 64),
      createdAt: this.clock(),
    };
    return inTransaction(this.gateway, async (uow) => {
      if (await uow.points.insertIfAbsent(entry)) {
        await uow.outbox.add(pointsGrantedEvent(entry, null));
        return entry;
      }
      // Reintento del mismo ajuste: se devuelve el que ya quedó, sin duplicarlo.
      return (await uow.points.findByIdempotencyKey(entry.idempotencyKey)) ?? entry;
    });
  }

  /** Los puntos que se le sugieren al dueño para cada estado (la pantalla los muestra al responder). */
  suggestions(actor: Actor): Partial<Record<FeedbackStatus, number>> {
    this.requirePlatform(actor);
    return { ...SUGGESTED_POINTS };
  }

  // ── Ayudantes ──────────────────────────────────────────────────────────────

  private requirePlatform(actor: Actor): void {
    if (!isPlatform(actor)) throw new ForbiddenError();
  }

  /** El envío con su conversación y sus puntos; si estaba «sin leer» para ese lado, deja de estarlo. */
  private async detail(item: FeedbackItem, side: 'author' | 'platform'): Promise<ItemDetail> {
    if ((side === 'platform' && item.unreadByPlatform) || (side === 'author' && item.unreadByAuthor)) {
      await inTransaction(this.gateway, async (uow) => {
        const fresh = await uow.items.findByIdForUpdate(item.id);
        if (!fresh) return;
        if (side === 'platform') fresh.unreadByPlatform = false;
        else fresh.unreadByAuthor = false;
        await uow.items.update(fresh);
        Object.assign(item, { unreadByPlatform: fresh.unreadByPlatform, unreadByAuthor: fresh.unreadByAuthor });
      });
    }
    return { item, replies: await this.repos.replies.listByItem(item.id), points: await this.repos.points.listByItem(item.id) };
  }

  private async addReply(uow: Repositories, item: FeedbackItem, actor: Actor, body: string, fromPlatform: boolean): Promise<FeedbackReply> {
    const now = this.clock();
    const reply: FeedbackReply = { id: this.ids(), itemId: item.id, authorId: actor.userId, fromPlatform, body, createdAt: now };
    await uow.replies.insert(reply);
    item.replyCount += 1;
    item.lastActivityAt = now;
    item.updatedAt = now;
    // Queda «sin leer» para el otro lado; quien escribe ya lo leyó.
    if (fromPlatform) {
      item.unreadByAuthor = true;
      item.unreadByPlatform = false;
    } else {
      item.unreadByPlatform = true;
      item.unreadByAuthor = false;
    }
    await uow.items.update(item);
    await uow.outbox.add(replyCreatedEvent(item, reply));
    return reply;
  }

  private async page(
    fetch: (before: ActivityCursor | undefined, limit: number) => Promise<FeedbackItem[]>,
    q: { cursor?: string; limit: number },
  ): Promise<{ items: FeedbackItem[]; nextCursor: string | null }> {
    const found = await fetch(decodeCursor(q.cursor), q.limit + 1);
    const items = found.slice(0, q.limit);
    const last = items[items.length - 1];
    return { items, nextCursor: found.length > q.limit && last ? encodeCursor({ lastActivityAt: last.lastActivityAt, id: last.id }) : null };
  }
}

function defaultReason(item: FeedbackItem): string {
  const what = item.kind === 'improvement' ? 'Mejora' : item.kind === 'problem' ? 'Reporte' : 'Comentario';
  return `${what}: ${item.title}`.slice(0, MAX_REASON);
}
