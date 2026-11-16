import { QueryTypes, type Transaction } from 'sequelize';
import { withActor } from '@facturero/outbox-relay';
import type { UnitOfWorkGateway, WriteUnitOfWork } from '../../application/ports.js';
import type {
  DomainEvent,
  ItemRepository,
  OrganizationBalance,
  OutboxRepository,
  PointsRepository,
  ReplyRepository,
  Repositories,
} from '../../domain/repositories.js';
import type { FeedbackItem, FeedbackReply, PointsEntry } from '../../domain/types.js';
import { sequelize } from './sequelize.js';

/**
 * Persistencia en MySQL con SQL a la vista (como chat-service): la idempotencia de los puntos es un `INSERT IGNORE` contra el UNIQUE de
 * `idempotency_key`, y responder bloquea el envío (`FOR UPDATE`) para que el contador de respuestas y el leído no se pisen.
 * BIGINT y SUM pueden llegar como texto según el driver: todo número pasa por `Number()`.
 */
type Row = Record<string, unknown>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toItem(r: Row): FeedbackItem {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    organizationName: str(r.organization_name),
    authorId: String(r.author_id),
    authorName: str(r.author_name),
    authorEmail: str(r.author_email),
    kind: r.kind as FeedbackItem['kind'],
    title: String(r.title),
    body: String(r.body),
    status: r.status as FeedbackItem['status'],
    traceId: str(r.trace_id),
    urlPath: str(r.url_path),
    unreadByPlatform: Boolean(r.unread_by_platform),
    unreadByAuthor: Boolean(r.unread_by_author),
    replyCount: num(r.reply_count),
    lastActivityAt: date(r.last_activity_at),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

const toReply = (r: Row): FeedbackReply => ({
  id: String(r.id),
  itemId: String(r.item_id),
  authorId: String(r.author_id),
  fromPlatform: Boolean(r.from_platform),
  body: String(r.body),
  createdAt: date(r.created_at),
});

const toEntry = (r: Row): PointsEntry => ({
  id: String(r.id),
  organizationId: String(r.organization_id),
  itemId: str(r.item_id),
  amount: num(r.amount),
  reason: String(r.reason),
  grantedBy: String(r.granted_by),
  idempotencyKey: String(r.idempotency_key),
  createdAt: date(r.created_at),
});

export function buildRepositories(tx?: Transaction): Repositories {
  const select = (sql: string, replacements: Record<string, unknown> = {}): Promise<Row[]> =>
    sequelize.query<Row>(sql, { replacements, type: QueryTypes.SELECT, transaction: tx });
  /** Filas afectadas (INSERT IGNORE que chocó con un UNIQUE = 0). */
  const write = async (sql: string, replacements: Record<string, unknown> = {}): Promise<number> => {
    const [result] = await sequelize.query(sql, { replacements, transaction: tx });
    const r = result as { affectedRows?: number } | number;
    return typeof r === 'number' ? r : num(r?.affectedRows);
  };
  const before = (q: { before?: { lastActivityAt: Date; id: string } }, alias = '') =>
    q.before ? ` AND (${alias}last_activity_at < :beforeAt OR (${alias}last_activity_at = :beforeAt AND ${alias}id < :beforeId))` : '';
  const beforeRepl = (q: { before?: { lastActivityAt: Date; id: string } }) => ({ beforeAt: q.before?.lastActivityAt ?? null, beforeId: q.before?.id ?? null });

  const itemColumns = (i: FeedbackItem) => ({
    ...i,
    unreadByPlatform: i.unreadByPlatform ? 1 : 0,
    unreadByAuthor: i.unreadByAuthor ? 1 : 0,
  });

  const items: ItemRepository = {
    async insert(i) {
      await write(
        `INSERT INTO feedback_items (id, organization_id, organization_name, author_id, author_name, author_email, kind, title, body, status,
            trace_id, url_path, unread_by_platform, unread_by_author, reply_count, last_activity_at, created_at, updated_at)
         VALUES (:id, :organizationId, :organizationName, :authorId, :authorName, :authorEmail, :kind, :title, :body, :status,
            :traceId, :urlPath, :unreadByPlatform, :unreadByAuthor, :replyCount, :lastActivityAt, :createdAt, :updatedAt)`,
        itemColumns(i),
      );
    },
    async findById(id) {
      const [r] = await select('SELECT * FROM feedback_items WHERE id = :id', { id });
      return r ? toItem(r) : null;
    },
    async findByIdForUpdate(id) {
      const [r] = await select(`SELECT * FROM feedback_items WHERE id = :id${tx ? ' FOR UPDATE' : ''}`, { id });
      return r ? toItem(r) : null;
    },
    async update(i) {
      await write(
        `UPDATE feedback_items SET status = :status, unread_by_platform = :unreadByPlatform, unread_by_author = :unreadByAuthor,
            reply_count = :replyCount, last_activity_at = :lastActivityAt, updated_at = :updatedAt WHERE id = :id`,
        itemColumns(i),
      );
    },
    async listByAuthor(organizationId, authorId, q) {
      const rows = await select(
        `SELECT * FROM feedback_items WHERE organization_id = :organizationId AND author_id = :authorId${before(q)}
          ORDER BY last_activity_at DESC, id DESC LIMIT :limit`,
        { organizationId, authorId, limit: q.limit, ...beforeRepl(q) },
      );
      return rows.map(toItem);
    },
    async listAll(f, q) {
      const where = ['1 = 1'];
      const repl: Record<string, unknown> = { limit: q.limit, ...beforeRepl(q) };
      if (f.status) {
        where.push('status = :status');
        repl.status = f.status;
      }
      if (f.kind) {
        where.push('kind = :kind');
        repl.kind = f.kind;
      }
      if (f.organizationId) {
        where.push('organization_id = :organizationId');
        repl.organizationId = f.organizationId;
      }
      if (f.unread) where.push('unread_by_platform = 1');
      if (f.q) {
        // `%` y `_` escritos por la persona son literales, no comodines.
        where.push('(title LIKE :q OR body LIKE :q OR author_name LIKE :q OR author_email LIKE :q OR organization_name LIKE :q)');
        repl.q = `%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      }
      const rows = await select(`SELECT * FROM feedback_items WHERE ${where.join(' AND ')}${before(q)} ORDER BY last_activity_at DESC, id DESC LIMIT :limit`, repl);
      return rows.map(toItem);
    },
    async countUnreadByAuthor(organizationId, authorId) {
      const [r] = await select('SELECT COUNT(*) AS n FROM feedback_items WHERE organization_id = :organizationId AND author_id = :authorId AND unread_by_author = 1', {
        organizationId,
        authorId,
      });
      return num(r?.n);
    },
    async countUnreadByPlatform() {
      const [r] = await select('SELECT COUNT(*) AS n FROM feedback_items WHERE unread_by_platform = 1');
      return num(r?.n);
    },
  };

  const replies: ReplyRepository = {
    async insert(r) {
      await write('INSERT INTO feedback_replies (id, item_id, author_id, from_platform, body, created_at) VALUES (:id, :itemId, :authorId, :fromPlatform, :body, :createdAt)', {
        ...r,
        fromPlatform: r.fromPlatform ? 1 : 0,
      });
    },
    async listByItem(itemId) {
      return (await select('SELECT * FROM feedback_replies WHERE item_id = :itemId ORDER BY created_at ASC, id ASC', { itemId })).map(toReply);
    },
  };

  const points: PointsRepository = {
    async insertIfAbsent(e) {
      return (
        (await write(
          `INSERT IGNORE INTO points_entries (id, organization_id, item_id, amount, reason, granted_by, idempotency_key, created_at)
           VALUES (:id, :organizationId, :itemId, :amount, :reason, :grantedBy, :idempotencyKey, :createdAt)`,
          { ...e },
        )) > 0
      );
    },
    async findByIdempotencyKey(key) {
      const [r] = await select('SELECT * FROM points_entries WHERE idempotency_key = :key', { key });
      return r ? toEntry(r) : null;
    },
    async balance(organizationId) {
      const [r] = await select('SELECT COALESCE(SUM(amount), 0) AS n FROM points_entries WHERE organization_id = :organizationId', { organizationId });
      return num(r?.n);
    },
    async listByOrganization(organizationId, limit) {
      return (await select('SELECT * FROM points_entries WHERE organization_id = :organizationId ORDER BY created_at DESC, id DESC LIMIT :limit', { organizationId, limit })).map(toEntry);
    },
    async listByItem(itemId) {
      return (await select('SELECT * FROM points_entries WHERE item_id = :itemId ORDER BY created_at ASC, id ASC', { itemId })).map(toEntry);
    },
    async balances() {
      const rows = await select(
        `SELECT p.organization_id, COALESCE(SUM(p.amount), 0) AS balance, COUNT(*) AS entries,
                (SELECT i.organization_name FROM feedback_items i WHERE i.organization_id = p.organization_id AND i.organization_name IS NOT NULL
                  ORDER BY i.created_at DESC LIMIT 1) AS organization_name
           FROM points_entries p GROUP BY p.organization_id ORDER BY balance DESC`,
      );
      return rows.map(
        (r): OrganizationBalance => ({ organizationId: String(r.organization_id), organizationName: str(r.organization_name), balance: num(r.balance), entries: num(r.entries) }),
      );
    },
  };

  const outbox: OutboxRepository = {
    async add(event: DomainEvent) {
      await write(
        `INSERT INTO outbox_messages (id, aggregate_type, aggregate_id, type, payload, occurred_at, processed_at)
         VALUES (:id, :aggregateType, :aggregateId, :type, :payload, :occurredAt, NULL)`,
        {
          id: event.eventId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          type: event.type,
          // Actor, IP y request-id viajan en el contexto de la petición (runWithActor del middleware).
          payload: JSON.stringify(withActor(event.payload)),
          occurredAt: event.occurredAt,
        },
      );
    },
  };

  return { items, replies, points, outbox };
}

/** Lecturas fuera de transacción. */
export const readOnlyRepositories: Repositories = buildRepositories();

class SequelizeUnitOfWork implements WriteUnitOfWork {
  readonly items;
  readonly replies;
  readonly points;
  readonly outbox;

  constructor(private readonly tx: Transaction) {
    const repos = buildRepositories(tx);
    this.items = repos.items;
    this.replies = repos.replies;
    this.points = repos.points;
    this.outbox = repos.outbox;
  }

  async commit(): Promise<void> {
    await this.tx.commit();
  }

  async rollback(): Promise<void> {
    // Tras un deadlock MySQL ya deshizo la transacción y Sequelize la da por terminada: un segundo rollback taparía el error real.
    if ((this.tx as unknown as { finished?: string }).finished) return;
    await this.tx.rollback();
  }
}

export class SequelizeUnitOfWorkFactory implements UnitOfWorkGateway {
  constructor(private readonly onBegin?: (tx: Transaction) => void) {}

  isRetryable(err: unknown): boolean {
    const e = err as { parent?: { code?: string; errno?: number }; original?: { code?: string; errno?: number } };
    const cause = e?.parent ?? e?.original;
    return cause?.code === 'ER_LOCK_DEADLOCK' || cause?.errno === 1213;
  }

  async begin(): Promise<WriteUnitOfWork> {
    const tx = await sequelize.transaction();
    // El relay publica el outbox justo tras el commit; sin este enganche los eventos esperan el barrido de respaldo.
    this.onBegin?.(tx);
    return new SequelizeUnitOfWork(tx);
  }
}
