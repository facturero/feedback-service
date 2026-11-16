# feedback-service — Comentarios, mejoras y puntos de fidelidad

Buzón donde las personas que usan el CRM mandan **mejoras, comentarios y reportes de problemas**; el dueño de la plataforma los lee,
responde y, cuando una mejora vale, **da puntos de fidelidad a la empresa** para canjearlos más adelante (descuentos, regalos, premios).
Nació porque «Reportar un problema» solo iba a SigNoz y, con el servidor de observabilidad apagado, los reportes se perdían.

Este archivo es la fuente de verdad y la memoria del servicio: leerlo antes de tocar nada y actualizar «Estado» al cerrar cada
entregable. Avance marcable en `CHECKLIST.md`. Contratos: `openapi.yaml` (REST) y `asyncapi.yaml` (eventos).

## Estado (2026-11-16)

En construcción. Nada subido. El repo de GitHub `facturero/feedback-service` existe (vacío, creado por el dueño el 2026-11-16); la
subida va junto con la del chat: `cmr-proyect/subir-feedback/SUBIR.md`.

| Entregable | Estado |
|---|---|
| E1 — Servicio, base de datos, API, eventos, pruebas | **Hecho en local** (verificado contra el stack real). Sin subir |
| E2 — Pantallas (usuario y dueño) y «Reportar un problema» al buzón | **Hecho en local** (probado en el navegador). Sin subir |
| E3 — Avisos (campana y correo a quien escribió) | Pendiente |
| E4 — Producción (repo, CI, secretos, k8s, gateway, despliegue) | **Preparado** (CI, k8s, script de secretos, comandos). Falta que el dueño suba y probar en producción |

## Decisiones del dueño (2026-11-16)

| Tema | Decisión |
|---|---|
| Quién ve y responde | **Solo el dueño de la plataforma**, de todas las empresas. Cada persona ve solo lo suyo y las respuestas |
| Quién acumula los puntos | **La empresa** (organización): una sola bolsa por empresa |
| Cómo se dan los puntos | **El dueño al responder**: al aceptar o implementar una mejora el sistema sugiere puntos y él confirma o cambia |
| «Reportar un problema» | **Un solo buzón**: los reportes de problemas también se guardan aquí (además de seguir yendo a SigNoz) |
| Dónde vive | **Servicio nuevo** `feedback-service` (repo, base y despliegue propios) |

## Reglas de implementación

1. Mismo stack y forma que chat-service: Node + Hono + Sequelize (SQL a mano en los repositorios) + MySQL, outbox con
   `@facturero/outbox-relay`, OpenTelemetry. Base `feedback_db`. Puerto **3022** (en el clúster y en el host local).
2. Identidad SIEMPRE de las cabeceras del gateway (`X-User-Id`, `X-Organization-Id`, `X-Permissions`). Nunca del cuerpo.
3. El nombre y el correo de quien escribe se copian al crear (directorio interno de auth: `GET /internal/organizations/:id/contacts`,
   con `INTERNAL_SERVICE_SECRET`): así el dueño los ve aunque la persona cambie o se vaya. El **nombre de la empresa** lo manda el
   navegador y es solo para mostrar (ningún servicio lo expone hoy); la empresa se identifica por su id.
4. **Permiso de plataforma `feedback:manage`** (como `tax:manage`): se añade a `PLATFORM_PERMISSIONS` en
   `auth-service/src/domain/rbac.ts` y solo lo reciben los usuarios `is_platform_admin`. No es asignable por empresa.
5. Mandar y leer lo propio: cualquier persona autenticada, sin permiso (no se puede pedir un permiso que nadie tenga por rol).
6. Quien no puede ver algo recibe **404** (no se confirma que existe una mejora de otra persona u otra empresa).
7. Texto plano (no editor enriquecido): título ≤ 160, cuerpo ≤ 4000, respuesta ≤ 4000. Saltos de línea sí.
8. Tope anti-spam: **10 envíos por persona por hora** (en memoria, como el de chat-service), con **cupo aparte para los problemas**: quien mandó muchas ideas igual puede reportar que algo se rompió.
9. Puntos: libro de movimientos (`points_entries`), nunca un saldo editable. El saldo es la suma. Cada movimiento lleva motivo, quién
   lo dio y la mejora (si viene de una). **Idempotente** con una clave del navegador (doble clic → un solo movimiento: UNIQUE).
10. Sugerencias de puntos (constantes, documentadas): **aceptada 50**, **implementada 200**. El dueño puede cambiar el monto o no dar.
    Montos negativos solo por ajuste manual del dueño (para el canje futuro o corregir un error), con motivo obligatorio.
11. Estados de un envío: `new` → `reviewing` → `accepted` → `implemented`, o `declined`. Solo el dueño los cambia.
12. Respuestas: el dueño responde; la persona puede contestar en la misma conversación. Leído/no leído por lado (`unread_by_platform`,
    `unread_by_author`) para los contadores.
13. Eventos (outbox, exchange `crm.events`), sin el texto (la auditoría guarda los payloads): `feedback.item.created`,
    `feedback.reply.created`, `feedback.item.status_changed`, `feedback.points.granted`. Con `userIds` = a quién avisar (la persona
    autora) para la campana de notification-service.
14. Reportes de problemas: tipo `problem`, con el **código de traza** (`traceId`) y la pantalla (`urlPath`) para cruzarlo con SigNoz.
    Desde el login (sin sesión) no se puede guardar: ahí sigue yendo solo a SigNoz.
15. Comentarios del código: el porqué, no el qué. Textos de cara a la persona en español (y i18n es/en/fr en el frontend).

## Modelo de datos (`feedback_db`)

- `feedback_items`: `id`, `organization_id`, `organization_name` (copia para mostrar), `author_id`, `author_name`, `author_email`,
  `kind` (`improvement` | `comment` | `problem`), `title`, `body`, `status`, `trace_id`, `url_path`, `unread_by_platform`,
  `unread_by_author`, `reply_count`, `last_activity_at`, `created_at`, `updated_at`.
- `feedback_replies`: `id`, `item_id`, `author_id`, `from_platform`, `body`, `created_at`.
- `points_entries`: `id`, `organization_id`, `item_id` (nulo en ajustes), `amount` (entero, puede ser negativo en ajustes), `reason`,
  `granted_by`, `idempotency_key` (UNIQUE), `created_at`.
- `outbox_messages` (forma de outbox-relay).

## API (detalle en `openapi.yaml`; en el gateway, una regla `ANY /feedback/*`)

Persona: `POST /feedback`, `GET /feedback` (lo mío), `GET /feedback/:id`, `POST /feedback/:id/replies`, `GET /feedback/points`
(saldo y movimientos de mi empresa), `GET /feedback/unread` (contador).
Dueño (`feedback:manage`): `GET /feedback/admin/items` (todas, con filtros), `GET /feedback/admin/items/:id`,
`POST /feedback/admin/items/:id/respond` (respuesta + estado + puntos en una sola acción), `GET /feedback/admin/points` (saldos por
empresa), `POST /feedback/admin/points` (ajuste manual), `GET /feedback/admin/unread`.

## Orden de despliegue (cuando toque)

1. **auth-service** (`feedback:manage` en `PLATFORM_PERMISSIONS`).
2. **feedback-service** (repo nuevo, migraciones, secretos, k8s).
3. **notification-service** (proveedores de avisos, E3).
4. **api-gateway-node** (`FEEDBACK_SERVICE_URL` y la regla `/feedback/*`).
5. **frontend**.

## Bitácora de construcción

(Por entregable: qué se hizo, cómo se verificó, bugs encontrados y decisiones al construir.)

**E1 (2026-11-16).** Servicio copiado del esqueleto de chat-service (mismas dependencias y lockfile: así `npm ci` no se desincroniza).
Decisiones al construir: el detalle de un envío tiene dos rutas, la de la persona (`/feedback/:id`, solo la autora) y la del dueño
(`/feedback/admin/items/:id`), para que un `is_platform_admin` que también usa el CRM como persona no mezcle las dos vistas; el dueño
responde solo por `respond` (una sola acción con respuesta, estado y puntos). Las rutas del dueño viven bajo `/feedback/admin/*` (no
`/admin/*`, que ya usa plugin-catalog) para que el gateway tenga una sola regla. En local se marcó a Lucía (admin de la demo) como
`is_platform_admin` para probar la bandeja del dueño. Verificado: 14 pruebas, `verify-feedback.mjs` contra el stack local (MySQL +
gateway + auth con tokens reales) y `check-all` en verde.

**E2 (2026-11-16).** Pantallas `/feedback` (todos) y `/platform/feedback` (`feedback:manage`), entradas en el menú del avatar con su
número, pieza compartida `FeedbackConversation` (lado persona / lado dueño). «Reportar un problema» guarda además una copia en el buzón.
Bugs que encontró la prueba en el navegador, corregidos: (1) al buscar o filtrar, la bandeja se cambiaba entera por la ruedita y
desmontaba la conversación abierta: ahora solo la primera carga muestra la ruedita; (2) tras responder con puntos, el interruptor «Dar
puntos» quedaba encendido con el monto y otra respuesta los volvía a dar: la conversación se rearma limpia tras cada respuesta;
(3) un reporte de problema chocaba con el tope de ideas (10/hora): los problemas tienen cupo aparte; (4) la respuesta de la plataforma
salía con el texto teñido de azul (`bg-lightprimary`): fondo con el token y texto normal.
