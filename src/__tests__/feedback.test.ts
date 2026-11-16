import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { actor, build, idea, OTHER_ORG, owner, user } from './helpers.js';

describe('la persona', () => {
  it('manda una mejora: se guarda con su nombre y correo (de auth), estado «nueva» y sin leer para la plataforma', async () => {
    const b = build();
    const item = await b.feedback.submit(actor(1), idea());
    expect(item).toMatchObject({ status: 'new', authorName: 'Persona 01', authorEmail: 'p01@ejemplo.ec', organizationName: 'Clínica Vida', unreadByPlatform: true });
    const [e] = b.store.events('feedback.item.created');
    expect(e.payload).toMatchObject({ itemId: item.id, organizationId: item.organizationId, kind: 'improvement' });
    expect(JSON.stringify(e.payload)).not.toContain('Excel'); // sin el texto (la auditoría guarda los payloads)
  });

  it('valida título y cuerpo, limpia espacios y frena el spam (10 por hora)', async () => {
    const b = build({ rate: 2 });
    await expect(b.feedback.submit(actor(1), { ...idea(), title: '   ' })).rejects.toMatchObject({ httpStatus: 422 });
    await expect(b.feedback.submit(actor(1), { ...idea(), body: 'x'.repeat(4001) })).rejects.toMatchObject({ httpStatus: 422 });
    const ok = await b.feedback.submit(actor(1), { ...idea(), body: '  hola\n\n\n\n mundo  ' });
    expect(ok.body).toBe('hola\n\n mundo');
    await b.feedback.submit(actor(1), idea());
    await expect(b.feedback.submit(actor(1), idea())).rejects.toMatchObject({ httpStatus: 429 });
    // Los problemas tienen su propio cupo: se pueden reportar aunque las ideas estén frenadas.
    expect((await b.feedback.submit(actor(1), idea('Se cayó', 'problem'))).kind).toBe('problem');
  });

  it('un reporte de problema guarda su código de traza y la pantalla; una mejora no guarda traza', async () => {
    const b = build();
    const bug = await b.feedback.submit(actor(1), { ...idea('No guarda la factura', 'problem'), traceId: 'abc123', urlPath: '/invoices/new' });
    expect([bug.traceId, bug.urlPath]).toEqual(['abc123', '/invoices/new']);
    const imp = await b.feedback.submit(actor(1), { ...idea(), traceId: 'zzz' });
    expect(imp.traceId).toBeNull();
  });

  it('solo ve lo suyo: lo de otra persona o de otra empresa es «no existe» (404)', async () => {
    const b = build();
    const mine = await b.feedback.submit(actor(1), idea());
    await b.feedback.submit(actor(2), idea('Otra'));
    expect((await b.feedback.listMine(actor(1), { limit: 20 })).items.map((i) => i.id)).toEqual([mine.id]);
    await expect(b.feedback.get(actor(2), mine.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(b.feedback.get(actor(1, { org: OTHER_ORG }), mine.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(b.feedback.reply(actor(2), mine.id, 'hola')).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe('el dueño de la plataforma', () => {
  it('nadie más entra a la bandeja ni da puntos (403)', async () => {
    const b = build();
    await expect(b.feedback.listAll(actor(1), {}, { limit: 10 })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(b.feedback.balances(actor(1))).rejects.toMatchObject({ httpStatus: 403 });
    const item = await b.feedback.submit(actor(1), idea());
    await expect(b.feedback.respond(actor(1), item.id, { body: 'auto-respuesta' })).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('ve las de todas las empresas, con filtros y búsqueda; abrir una la marca leída por su lado', async () => {
    const b = build();
    const a = await b.feedback.submit(actor(1), idea());
    await b.feedback.submit(actor(2, { org: OTHER_ORG }), { ...idea('Modo oscuro', 'comment'), organizationName: 'Ecomarket' });
    expect((await b.feedback.listAll(owner(), {}, { limit: 10 })).items).toHaveLength(2);
    expect((await b.feedback.listAll(owner(), { kind: 'comment' }, { limit: 10 })).items.map((i) => i.title)).toEqual(['Modo oscuro']);
    expect((await b.feedback.listAll(owner(), { q: 'clínica' }, { limit: 10 })).items.map((i) => i.id)).toEqual([a.id]);
    expect(await b.feedback.unreadForPlatform(owner())).toBe(2);
    await b.feedback.getAsPlatform(owner(), a.id);
    expect(await b.feedback.unreadForPlatform(owner())).toBe(1);
  });

  it('responde, cambia el estado y da puntos en una sola acción; a la persona le queda «sin leer» y se le avisa', async () => {
    const b = build();
    const item = await b.feedback.submit(actor(1), idea());
    const d = await b.feedback.respond(owner(), item.id, { body: '¡Buena idea! La hacemos este mes.', status: 'accepted', points: { amount: 50, idempotencyKey: randomUUID() } });
    expect(d.item.status).toBe('accepted');
    expect(d.replies.map((r) => [r.fromPlatform, r.body])).toEqual([[true, '¡Buena idea! La hacemos este mes.']]);
    expect(d.points.map((p) => p.amount)).toEqual([50]);
    expect(d.points[0].reason).toBe('Mejora: Exportar clientes a Excel');
    expect(await b.feedback.unreadForAuthor(actor(1))).toBe(1);
    for (const type of ['feedback.reply.created', 'feedback.item.status_changed', 'feedback.points.granted']) {
      expect(b.store.events(type)[0]?.payload.userIds, type).toEqual([user(1)]);
    }
    // La persona lo abre: ya no está sin leer, y contesta (a la plataforma le queda sin leer).
    await b.feedback.get(actor(1), item.id);
    expect(await b.feedback.unreadForAuthor(actor(1))).toBe(0);
    const r = await b.feedback.reply(actor(1), item.id, '¡Gracias!');
    expect(r.fromPlatform).toBe(false);
    expect((await b.feedback.getAsPlatform(owner(), item.id)).replies).toHaveLength(2);
  });

  it('los puntos son de la empresa: suman por organización y un doble clic no los da dos veces', async () => {
    const b = build();
    const a = await b.feedback.submit(actor(1), idea());
    const c = await b.feedback.submit(actor(2), idea('Otra'));
    const key = randomUUID();
    await b.feedback.respond(owner(), a.id, { status: 'implemented', points: { amount: 200, idempotencyKey: key } });
    await b.feedback.respond(owner(), a.id, { points: { amount: 200, idempotencyKey: key } }); // doble clic
    await b.feedback.respond(owner(), c.id, { points: { amount: 50, idempotencyKey: randomUUID() } });
    expect((await b.feedback.myPoints(actor(3))).balance).toBe(250); // otra persona de la misma empresa ve el saldo de la empresa
    expect(b.store.events('feedback.points.granted')).toHaveLength(2);
    expect(await b.feedback.balances(owner())).toEqual([{ organizationId: a.organizationId, organizationName: 'Clínica Vida', balance: 250, entries: 2 }]);
  });

  it('ajuste manual con motivo (puede restar, para el canje futuro); idempotente; montos inválidos rechazados', async () => {
    const b = build();
    const item = await b.feedback.submit(actor(1), idea());
    await b.feedback.respond(owner(), item.id, { points: { amount: 200, idempotencyKey: randomUUID() } });
    const key = randomUUID();
    const e = await b.feedback.adjustPoints(owner(), { organizationId: item.organizationId, amount: -100, reason: 'Canje: 10% de descuento en Proyectos', idempotencyKey: key });
    const again = await b.feedback.adjustPoints(owner(), { organizationId: item.organizationId, amount: -100, reason: 'Canje: 10% de descuento en Proyectos', idempotencyKey: key });
    expect(again.id).toBe(e.id);
    expect((await b.feedback.myPoints(actor(1))).balance).toBe(100);
    await expect(b.feedback.adjustPoints(owner(), { organizationId: item.organizationId, amount: 0, reason: 'x', idempotencyKey: randomUUID() })).rejects.toMatchObject({ httpStatus: 422 });
    await expect(b.feedback.adjustPoints(owner(), { organizationId: item.organizationId, amount: 10, reason: ' ', idempotencyKey: randomUUID() })).rejects.toMatchObject({ httpStatus: 422 });
    await expect(b.feedback.respond(owner(), item.id, { points: { amount: -5, idempotencyKey: randomUUID() } })).rejects.toMatchObject({ httpStatus: 422 });
  });

  it('pagina por cursor, la de actividad más reciente primero (una respuesta la sube)', async () => {
    const b = build();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await b.feedback.submit(actor(1), idea(`Idea ${i}`))).id);
    await b.feedback.respond(owner(), ids[0], { body: 'La vemos' });
    const p1 = await b.feedback.listMine(actor(1), { limit: 3 });
    expect(p1.items[0].id).toBe(ids[0]);
    const p2 = await b.feedback.listMine(actor(1), { limit: 3, cursor: p1.nextCursor! });
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(5);
  });
});
