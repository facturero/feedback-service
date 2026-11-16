#!/usr/bin/env node
// Verificación de feedback-service contra el stack LOCAL real (gateway en :8080, MySQL en :3307): la persona manda y ve lo suyo, el
// dueño de la plataforma (is_platform_admin → `feedback:manage`) responde con estado y puntos, y la concurrencia de los puntos (10
// «responder con puntos» a la vez con la misma clave → UN movimiento) se comprueba en MySQL.
//
//   node scripts/verify-feedback.mjs            (credenciales de prueba en ../../seed/.env.demo-chat, o VERIFY_ENV=<archivo>)
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const API = process.env.API_URL ?? 'http://localhost:8080';
const envFile = process.env.VERIFY_ENV ?? new URL('../../../seed/.env.demo-chat', import.meta.url);
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${msg}`);
};
const login = async (email, password) => (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
async function api(session, method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const persona = await login(env.NEW_EMAIL, env.NEW_PASSWORD);
const companera = await login(env.MEMBER_EMAIL_TEMPLATE.replace('{nombre}', 'ana'), env.MEMBER_PASSWORD);
const owner = await login(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
const db = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.MYSQL_PORT ?? 3307), user: 'root', password: 'root123' });
const tag = randomUUID().slice(0, 6);

// 1. La persona manda una mejora; se guarda con su nombre y correo (de auth) y el evento no lleva el texto.
const created = await api(persona, 'POST', '/feedback', { kind: 'improvement', title: `Exportar a Excel ${tag}`, body: `Detalle secreto ${tag}`, organizationName: 'Demo' });
check(created.status === 201 && created.body.status === 'new' && created.body.authorEmail === undefined, `mandar una mejora (${created.status}); la persona no recibe datos de contacto`);
const id = created.body.id;
const [[row]] = await db.query('SELECT author_name, author_email, unread_by_platform FROM feedback_db.feedback_items WHERE id = ?', [id]);
check(row?.author_email === env.NEW_EMAIL && !!row?.author_name && row.unread_by_platform === 1, `en MySQL: nombre y correo copiados de auth (${row?.author_name}), sin leer para la plataforma`);
const [[{ leaks }]] = await db.query("SELECT COUNT(*) AS leaks FROM feedback_db.outbox_messages WHERE JSON_SEARCH(payload, 'one', ?) IS NOT NULL", [`%secreto ${tag}%`]);
check(Number(leaks) === 0, 'ningún evento del outbox lleva el texto');

// 2. Permisos: otra persona no lo ve (404) ni entra a la bandeja del dueño (403).
check((await api(companera, 'GET', `/feedback/${id}`)).status === 404, 'otra persona de la empresa: 404');
check((await api(persona, 'GET', '/feedback/admin/items')).status === 403, 'la persona en la bandeja del dueño: 403');

// 3. El dueño ve el envío con los datos de contacto y lo marca leído al abrirlo.
const inbox = await api(owner, 'GET', `/feedback/admin/items?q=${encodeURIComponent(tag)}`);
check(inbox.status === 200 && inbox.body.items.length === 1 && inbox.body.items[0].authorEmail === env.NEW_EMAIL, `el dueño (is_platform_admin) lo ve con el correo (${inbox.status})`);

// 4. Responder con puntos: 10 a la vez con la misma clave → un solo movimiento en MySQL.
const key = randomUUID();
const resps = await Promise.all(Array.from({ length: 10 }, () => api(owner, 'POST', `/feedback/admin/items/${id}/respond`, { status: 'accepted', points: { amount: 50, idempotencyKey: key } })));
const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM feedback_db.points_entries WHERE idempotency_key = ?', [key]);
check(resps.every((r) => r.status === 200) && Number(n) === 1, `10 «responder con puntos» simultáneos → 1 movimiento (${n}); estados ${[...new Set(resps.map((r) => r.status))].join('/')}`);
const reply = await api(owner, 'POST', `/feedback/admin/items/${id}/respond`, { body: '¡Gracias! La hacemos este mes.' });
check(reply.status === 200 && reply.body.replies.at(-1)?.fromPlatform === true && reply.body.item.status === 'accepted', 'respuesta del dueño en la conversación');

// 5. La persona ve la respuesta y su empresa tiene los puntos (también la compañera: los puntos son de la empresa).
check((await api(persona, 'GET', '/feedback/unread')).body.count >= 1, 'la persona tiene novedades sin leer');
const seen = await api(persona, 'GET', `/feedback/${id}`);
check(seen.body.replies.length === 1 && seen.body.points[0]?.amount === 50, 'la persona ve la respuesta y los 50 puntos de su mejora');
const before = (await api(companera, 'GET', '/feedback/points')).body.balance;
check(before >= 50, `saldo de la empresa visible para la compañera (${before})`);

// 6. Ajuste manual negativo (canje) idempotente y saldos por empresa.
const adjKey = randomUUID();
const orgId = inbox.body.items[0].organizationId;
await Promise.all([1, 2, 3].map(() => api(owner, 'POST', '/feedback/admin/points', { organizationId: orgId, amount: -20, reason: `Canje de prueba ${tag}`, idempotencyKey: adjKey })));
const after = (await api(persona, 'GET', '/feedback/points')).body.balance;
check(after === before - 20, `ajuste de -20 aplicado una sola vez (${before} → ${after})`);
const balances = await api(owner, 'GET', '/feedback/admin/points');
check(balances.body.items.some((b) => b.organizationId === orgId && b.balance === after), 'saldos por empresa para el dueño');

await db.end();
console.log(failures ? `\n${failures} verificación(es) fallaron.` : '\nTodo en verde.');
process.exit(failures ? 1 : 0);
