import { randomUUID } from 'node:crypto';
import type { PeopleDirectory, UnitOfWorkGateway, WriteUnitOfWork } from '../application/ports.js';
import { FeedbackUseCases, SubmitRateLimiter } from '../application/use-cases/feedback-use-cases.js';
import type { DomainEvent, Repositories } from '../domain/repositories.js';
import type { Actor, FeedbackItem, FeedbackReply, PointsEntry } from '../domain/types.js';
import { createApp } from '../interface/http/app.js';

/**
 * Repositorios en memoria con la misma semántica que los de MySQL: orden por última actividad e id, «insertar si no existe» contra la
 * misma clave única (`idempotency_key`). Las transacciones se serializan con un cerrojo y copian el estado al empezar: deshacer lo
 * descarta entero, fila y evento.
 */
interface State {
  items: Map<string, FeedbackItem>;
  replies: FeedbackReply[];
  points: PointsEntry[];
  outbox: DomainEvent[];
}

const empty = (): State => ({ items: new Map(), replies: [], points: [], outbox: [] });
const clone = (s: State): State => ({
  items: new Map([...s.items].map(([k, v]) => [k, { ...v }])),
  replies: [...s.replies],
  points: [...s.points],
  outbox: [...s.outbox],
});
const newerFirst = (a: FeedbackItem, b: FeedbackItem) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || (a.id < b.id ? 1 : -1);
const olderThan = (i: FeedbackItem, before?: { lastActivityAt: Date; id: string }) =>
  !before || i.lastActivityAt < before.lastActivityAt || (i.lastActivityAt.getTime() === before.lastActivityAt.getTime() && i.id < before.id);

function repositoriesOver(s: () => State): Repositories {
  return {
    items: {
      async insert(i) { s().items.set(i.id, { ...i }); },
      async findById(id) { const i = s().items.get(id); return i ? { ...i } : null; },
      async findByIdForUpdate(id) { const i = s().items.get(id); return i ? { ...i } : null; },
      async update(i) { s().items.set(i.id, { ...i }); },
      async listByAuthor(org, author, q) {
        return [...s().items.values()].filter((i) => i.organizationId === org && i.authorId === author && olderThan(i, q.before)).sort(newerFirst).slice(0, q.limit).map((i) => ({ ...i }));
      },
      async listAll(f, q) {
        const needle = f.q?.toLowerCase();
        return [...s().items.values()]
          .filter((i) => (!f.status || i.status === f.status) && (!f.kind || i.kind === f.kind) && (!f.organizationId || i.organizationId === f.organizationId))
          .filter((i) => !f.unread || i.unreadByPlatform)
          .filter((i) => !needle || [i.title, i.body, i.authorName, i.authorEmail, i.organizationName].some((x) => x?.toLowerCase().includes(needle)))
          .filter((i) => olderThan(i, q.before))
          .sort(newerFirst)
          .slice(0, q.limit)
          .map((i) => ({ ...i }));
      },
      async countUnreadByAuthor(org, author) { return [...s().items.values()].filter((i) => i.organizationId === org && i.authorId === author && i.unreadByAuthor).length; },
      async countUnreadByPlatform() { return [...s().items.values()].filter((i) => i.unreadByPlatform).length; },
    },
    replies: {
      async insert(r) { s().replies.push({ ...r }); },
      async listByItem(itemId) { return s().replies.filter((r) => r.itemId === itemId).map((r) => ({ ...r })); },
    },
    points: {
      async insertIfAbsent(e) {
        if (s().points.some((x) => x.idempotencyKey === e.idempotencyKey)) return false;
        s().points.push({ ...e });
        return true;
      },
      async findByIdempotencyKey(key) { return s().points.find((x) => x.idempotencyKey === key) ?? null; },
      async balance(org) { return s().points.filter((x) => x.organizationId === org).reduce((n, x) => n + x.amount, 0); },
      async listByOrganization(org, limit) { return s().points.filter((x) => x.organizationId === org).reverse().slice(0, limit); },
      async listByItem(itemId) { return s().points.filter((x) => x.itemId === itemId); },
      async balances() {
        const orgs = [...new Set(s().points.map((x) => x.organizationId))];
        return orgs
          .map((organizationId) => {
            const mine = s().points.filter((x) => x.organizationId === organizationId);
            const name = [...s().items.values()].filter((i) => i.organizationId === organizationId && i.organizationName).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.organizationName ?? null;
            return { organizationId, organizationName: name, balance: mine.reduce((n, x) => n + x.amount, 0), entries: mine.length };
          })
          .sort((a, b) => b.balance - a.balance);
      },
    },
    outbox: { async add(e) { s().outbox.push(e); } },
  };
}

export class MemoryStore implements UnitOfWorkGateway {
  state: State = empty();
  readonly repos: Repositories = repositoriesOver(() => this.state);
  private queue: Promise<void> = Promise.resolve();

  async begin(): Promise<WriteUnitOfWork> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((ok) => (release = ok));
    await previous;
    const working = clone(this.state);
    const repos = repositoriesOver(() => working);
    let done = false;
    return {
      ...repos,
      commit: async () => {
        if (done) return;
        this.state = working;
        done = true;
        release();
      },
      rollback: async () => {
        if (done) return;
        done = true;
        release();
      },
    };
  }

  events(type?: string): DomainEvent[] {
    return type ? this.state.outbox.filter((e) => e.type === type) : this.state.outbox;
  }
}

export class FakePeople implements PeopleDirectory {
  async contact(_org: string, userId: string) {
    return { name: `Persona ${userId.slice(-2)}`, email: `p${userId.slice(-2)}@ejemplo.ec` };
  }
}

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
export const user = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const actor = (n: number, opts: { org?: string; platform?: boolean } = {}): Actor => ({
  userId: user(n),
  organizationId: opts.org ?? ORG,
  permissions: opts.platform ? ['feedback:manage'] : ['customer:read'],
});
/** El dueño de la plataforma: usuario 99, en su propia organización. */
export const owner = () => actor(99, { org: '99999999-9999-4999-8999-999999999999', platform: true });

export function build(opts: { rate?: number } = {}) {
  const store = new MemoryStore();
  let t = Date.parse('2026-11-16T12:00:00Z');
  const clock = () => new Date((t += 1000));
  const feedback = new FeedbackUseCases(store, store.repos, new FakePeople(), new SubmitRateLimiter(opts.rate ?? 1000, 3_600_000, clock), clock, randomUUID);
  const app = createApp({ useCases: { feedback }, corsOrigin: '*' }, { log: false });
  return { store, feedback, app };
}

export const idea = (title = 'Exportar clientes a Excel', kind: 'improvement' | 'comment' | 'problem' = 'improvement') => ({
  kind,
  title,
  body: 'Sería útil poder bajar la lista de clientes para el contador.',
  organizationName: 'Clínica Vida',
});
