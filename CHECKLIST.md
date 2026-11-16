# feedback-service — listado marcable

Reglas y decisiones en `IMPLEMENTATION.md`. Marcar al terminar y verificar (no antes).

## E1 — Servicio, base de datos, API, eventos

- [x] Esqueleto (copiado de chat-service): package, tsconfig, Dockerfile, sequelize, config, telemetría, outbox, `main.ts`; repo git local (rama `main`), `node_modules` enlazado al de chat-service para compilar en local
- [x] Migración `20261116120000-feedback-model.cjs`: `feedback_items`, `feedback_replies`, `points_entries` (UNIQUE `idempotency_key`), `outbox_messages`
- [x] Dominio: tipos, estados, límites de texto, puntos sugeridos (aceptada 50, implementada 200), permiso de plataforma
- [x] Casos de uso: enviar (tope 10/hora), mis envíos, ver uno (marca leído), contestar; dueño: bandeja con filtros y búsqueda, ver, responder (+estado +puntos idempotentes), saldos, ajuste manual
- [x] HTTP + validadores + `openapi.yaml` (14 rutas) + `verify:openapi`
- [x] Eventos sin texto (4) + `asyncapi.yaml` + `verify:asyncapi`
- [x] Pruebas (14, memoria + HTTP) + `scripts/verify-feedback.mjs` contra el stack local por el gateway (10 «responder con puntos» simultáneos → 1 movimiento; ajuste x3 → 1)
- [x] (auth-service) `feedback:manage` en `PLATFORM_PERMISSIONS` (+ su prueba); `check-permissions.mjs` lo reconoce como de plataforma
- [x] Raíz: `docker-compose.yml` (migrate + servicio, host 3022; gateway con `FEEDBACK_SERVICE_URL`), `docker/mysql/init.sql` (`feedback_db`)
- [x] (api-gateway-node) `FEEDBACK_SERVICE_URL` (env, k8s) + regla `ANY /feedback/*` (cubre `/feedback`) + `feedback-routes.test.ts`

## E2 — Pantallas

- [x] «Comentarios y mejoras» (`/feedback`, menú del avatar con número de novedades): mandar (mejora/comentario/problema), mis envíos, conversación, estado, puntos de la empresa con movimientos
- [x] Bandeja del dueño (`/platform/feedback`, solo con `feedback:manage`): búsqueda y filtros, responder con estado y puntos sugeridos, saldos por empresa, ajuste manual
- [x] «Reportar un problema» también guarda en el buzón (tipo problema, con su código de traza; desde el login solo va a SigNoz); cupo aparte de envíos para los problemas
- [x] i18n es/en/fr (`feedbackBox.*`), `lint:ui`, build, prueba en navegador de punta a punta (`subir-feedback/pruebas/feedback-ui.mjs`: 15 comprobaciones, escritorio y teléfono)

## E3 — Avisos

- [ ] (notification-service) proveedores: respuesta, cambio de estado y puntos → campana y correo a quien escribió
- [x] Etiquetas `audit.event.feedback_*` en el frontend es/en/fr (las exige `lint:ui`; la auditoría consume `#` y ya los guarda)

## E4 — Producción

- [x] El dueño crea el repo `facturero/feedback-service` (rama `main`)
- [ ] El dueño da acceso de Actions al paquete `outbox-relay` (el CI usa `GITHUB_TOKEN`, sin secreto `NODE_AUTH_TOKEN`) y corre `subir-feedback/preparar-produccion.sh` (base, usuario y `config/secrets.production.enc`)
- [x] CI (`.github/workflows/deploy.yml`), `k8s/deployment.yaml` + `service.yaml`, `.sops.yaml`
- [x] Comandos de commit por repo en el orden de despliegue: `cmr-proyect/subir-feedback/SUBIR.md` (conjunta con el chat)
- [ ] Subida (la hace el dueño) y prueba en producción; el dueño se marca `is_platform_admin`
