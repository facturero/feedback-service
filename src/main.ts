import './infrastructure/telemetry/otel.js';
import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { OutboxRelay } from '@facturero/outbox-relay';
import { config } from './infrastructure/config.js';
import { sequelize } from './infrastructure/persistence/sequelize.js';
import { readOnlyRepositories, SequelizeUnitOfWorkFactory } from './infrastructure/persistence/repositories.js';
import { AuthPeopleDirectory } from './infrastructure/http/auth-directory.js';
import { FeedbackUseCases, SubmitRateLimiter } from './application/use-cases/feedback-use-cases.js';
import { createApp } from './interface/http/app.js';

async function main(): Promise<void> {
  // NO `sequelize.sync()`: la migración (initContainer feedback-migrate) es la fuente de verdad del esquema.
  await sequelize.authenticate();

  let relay: OutboxRelay | undefined;
  const gateway = new SequelizeUnitOfWorkFactory((tx) => relay?.attachToTransaction(tx));
  if (!config.INTERNAL_SERVICE_SECRET) console.warn('[feedback-service] INTERNAL_SERVICE_SECRET vacío: los envíos se guardan sin nombre ni correo de quien escribe');

  const feedback = new FeedbackUseCases(
    gateway,
    readOnlyRepositories,
    new AuthPeopleDirectory(config.AUTH_SERVICE_URL, config.INTERNAL_SERVICE_SECRET),
    new SubmitRateLimiter(config.SUBMITS_PER_HOUR || Number.MAX_SAFE_INTEGER),
    () => new Date(),
    () => randomUUID(),
  );
  const app = createApp({ useCases: { feedback }, corsOrigin: config.CORS_ORIGIN });
  serve({ fetch: app.fetch, port: config.PORT });
  console.log(`[feedback-service] corriendo en puerto ${config.PORT}`);

  if (config.RABBITMQ_URL) {
    relay = new OutboxRelay({ sequelize, rabbitmqUrl: config.RABBITMQ_URL, exchange: 'crm.events' });
    await relay.start();
    console.log('[feedback-service] outbox relay activo');
  } else {
    console.warn('[feedback-service] RABBITMQ_URL no configurado: los eventos NO se publican');
  }
}

main().catch((err) => {
  console.error('[feedback-service] error al iniciar:', err);
  process.exit(1);
});
