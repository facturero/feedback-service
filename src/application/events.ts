import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../domain/repositories.js';
import type { FeedbackItem, FeedbackReply, PointsEntry } from '../domain/types.js';

/**
 * Eventos del buzón (contrato en `asyncapi.yaml`). Sin el texto de lo que escribió la persona ni de la respuesta: la bitácora de
 * auditoría guarda los payloads de cada organización, y para avisar basta con el id (el navegador pide el resto por REST).
 *
 * `userIds`: a quién avisar (campana y correo de notification-service). Solo la persona autora, y nunca a quien hizo la acción.
 */
const event = (type: string, aggregateId: string, payload: Record<string, unknown>, at: Date): DomainEvent => ({
  eventId: randomUUID(),
  aggregateType: 'feedback_item',
  aggregateId,
  type,
  payload,
  occurredAt: at,
});

const base = (item: FeedbackItem) => ({ itemId: item.id, organizationId: item.organizationId, kind: item.kind, authorId: item.authorId });

export const itemCreatedEvent = (item: FeedbackItem) => event('feedback.item.created', item.id, { ...base(item), status: item.status, userIds: [] }, item.createdAt);

export const replyCreatedEvent = (item: FeedbackItem, reply: FeedbackReply) =>
  event(
    'feedback.reply.created',
    item.id,
    { ...base(item), replyId: reply.id, fromPlatform: reply.fromPlatform, userIds: reply.fromPlatform && reply.authorId !== item.authorId ? [item.authorId] : [] },
    reply.createdAt,
  );

export const statusChangedEvent = (item: FeedbackItem, previous: string, actorId: string, at: Date) =>
  event('feedback.item.status_changed', item.id, { ...base(item), previousStatus: previous, status: item.status, userIds: actorId === item.authorId ? [] : [item.authorId] }, at);

export const pointsGrantedEvent = (entry: PointsEntry, item: FeedbackItem | null) => ({
  ...event('feedback.points.granted', entry.itemId ?? entry.id, {
    organizationId: entry.organizationId,
    itemId: entry.itemId,
    entryId: entry.id,
    amount: entry.amount,
    userIds: item && item.authorId !== entry.grantedBy ? [item.authorId] : [],
  }, entry.createdAt),
  aggregateType: 'feedback_points',
});
