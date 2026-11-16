import type { FeedbackItem, FeedbackKind, FeedbackReply, FeedbackStatus, PointsEntry } from './types.js';

export interface DomainEvent {
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

/** Paginación «más antiguos que este»: por última actividad e id (los empates de fecha se rompen por id). */
export interface ActivityCursor {
  lastActivityAt: Date;
  id: string;
}

export interface ItemFilters {
  status?: FeedbackStatus;
  kind?: FeedbackKind;
  organizationId?: string;
  /** Solo los que el dueño no leyó. */
  unread?: boolean;
  /** Busca en título, cuerpo, persona y empresa. */
  q?: string;
}

export interface ItemRepository {
  insert(item: FeedbackItem): Promise<void>;
  findById(id: string): Promise<FeedbackItem | null>;
  /** Con bloqueo de escritura: responder y cambiar el estado de uno a la vez (contador de respuestas, leído). */
  findByIdForUpdate(id: string): Promise<FeedbackItem | null>;
  update(item: FeedbackItem): Promise<void>;
  listByAuthor(organizationId: string, authorId: string, q: { before?: ActivityCursor; limit: number }): Promise<FeedbackItem[]>;
  listAll(filters: ItemFilters, q: { before?: ActivityCursor; limit: number }): Promise<FeedbackItem[]>;
  countUnreadByAuthor(organizationId: string, authorId: string): Promise<number>;
  countUnreadByPlatform(): Promise<number>;
}

export interface ReplyRepository {
  insert(reply: FeedbackReply): Promise<void>;
  listByItem(itemId: string): Promise<FeedbackReply[]>;
}

export interface OrganizationBalance {
  organizationId: string;
  organizationName: string | null;
  balance: number;
  entries: number;
}

export interface PointsRepository {
  /** INSERT IGNORE por `idempotency_key`: false si ese movimiento ya estaba (doble clic, reintento). */
  insertIfAbsent(entry: PointsEntry): Promise<boolean>;
  findByIdempotencyKey(key: string): Promise<PointsEntry | null>;
  balance(organizationId: string): Promise<number>;
  listByOrganization(organizationId: string, limit: number): Promise<PointsEntry[]>;
  listByItem(itemId: string): Promise<PointsEntry[]>;
  /** Saldos de todas las empresas con movimientos, el mayor primero (con el nombre más reciente que se conoce de cada una). */
  balances(): Promise<OrganizationBalance[]>;
}

export interface OutboxRepository {
  add(event: DomainEvent): Promise<void>;
}

export interface Repositories {
  items: ItemRepository;
  replies: ReplyRepository;
  points: PointsRepository;
  outbox: OutboxRepository;
}
