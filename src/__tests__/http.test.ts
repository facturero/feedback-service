import { describe, expect, it } from 'vitest';
import { build, ORG, user } from './helpers.js';

const headers = (n: number, opts: { org?: string; platform?: boolean } = {}) => ({
  'Content-Type': 'application/json',
  'X-User-Id': user(n),
  'X-Organization-Id': opts.org ?? ORG,
  'X-Permissions': opts.platform ? 'feedback:manage' : 'customer:read',
});
const OWNER = { org: '99999999-9999-4999-8999-999999999999', platform: true };

describe('HTTP', () => {
  it('sin cabeceras del gateway: 401', async () => {
    const { app } = build();
    expect((await app.request('/feedback')).status).toBe(401);
  });

  it('la persona manda y ve lo suyo sin datos de contacto; el dueño ve persona, correo y empresa', async () => {
    const { app } = build();
    const created = await app.request('/feedback', {
      method: 'POST',
      headers: headers(1),
      body: JSON.stringify({ kind: 'improvement', title: 'Atajos de teclado', body: 'Para facturar más rápido.', organizationName: 'Clínica Vida' }),
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string; authorEmail?: string };
    expect(item.authorEmail).toBeUndefined();

    const mine = (await (await app.request(`/feedback/${item.id}`, { headers: headers(1) })).json()) as { item: { authorEmail?: string } };
    expect(mine.item.authorEmail).toBeUndefined();
    const asOwner = (await (await app.request(`/feedback/admin/items/${item.id}`, { headers: headers(99, OWNER) })).json()) as { item: Record<string, unknown> };
    expect(asOwner.item).toMatchObject({ authorEmail: 'p01@ejemplo.ec', organizationName: 'Clínica Vida', organizationId: ORG });
  });

  it('las rutas fijas no las traga `:itemId` (admin, points, unread) y un id que no es uuid es 404', async () => {
    const { app } = build();
    expect((await app.request('/feedback/points', { headers: headers(1) })).status).toBe(200);
    expect((await app.request('/feedback/unread', { headers: headers(1) })).status).toBe(200);
    expect((await app.request('/feedback/admin/items', { headers: headers(1) })).status).toBe(403);
    expect((await app.request('/feedback/admin/items', { headers: headers(99, OWNER) })).status).toBe(200);
    expect((await app.request('/feedback/no-es-un-id', { headers: headers(1) })).status).toBe(404);
  });

  it('responder con puntos por HTTP: el saldo de la empresa sube y la sugerencia se puede leer', async () => {
    const { app } = build();
    const item = (await (
      await app.request('/feedback', { method: 'POST', headers: headers(1), body: JSON.stringify({ kind: 'improvement', title: 'Modo oscuro', body: 'Para la noche.' }) })
    ).json()) as { id: string };
    const sugg = (await (await app.request('/feedback/admin/suggestions', { headers: headers(99, OWNER) })).json()) as { points: Record<string, number> };
    expect(sugg.points).toEqual({ accepted: 50, implemented: 200 });
    const res = await app.request(`/feedback/admin/items/${item.id}/respond`, {
      method: 'POST',
      headers: headers(99, OWNER),
      body: JSON.stringify({ body: 'Aceptada', status: 'accepted', points: { amount: sugg.points.accepted, idempotencyKey: 'k-1' } }),
    });
    expect(res.status).toBe(200);
    const points = (await (await app.request('/feedback/points', { headers: headers(2) })).json()) as { balance: number };
    expect(points.balance).toBe(50);
  });
});
