import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3022),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),
  RABBITMQ_URL: z.string().optional(),
  // Directorio de auth-service: nombre y correo de quien escribe (regla 3 de IMPLEMENTATION.md).
  AUTH_SERVICE_URL: z.string().default('http://auth-service:3001'),
  INTERNAL_SERVICE_SECRET: z.string().default(''),
  CORS_ORIGIN: z.string().default('*'),
  // Envíos por hora por persona (regla 8). 0 lo apaga (pruebas de carga, semillas).
  SUBMITS_PER_HOUR: z.coerce.number().int().min(0).default(10),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Configuración de entorno inválida:\n${issues}`);
  process.exit(1);
}

export const config = parsed.data;
