import type { Repositories } from '../domain/repositories.js';

/** Repositorios que comparten una transacción y saben cerrarla. */
export interface WriteUnitOfWork extends Repositories {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Abre unidades de trabajo de escritura: en producción, una transacción de Sequelize; en las pruebas, repos en memoria. */
export interface UnitOfWorkGateway {
  begin(): Promise<WriteUnitOfWork>;
  /** ¿El error deshizo la transacción entera y se puede repetir tal cual? En MySQL, un deadlock (la base ya la deshizo). */
  isRetryable?(err: unknown): boolean;
}

const MAX_ATTEMPTS = 5;

/** Ejecuta `fn` en una transacción: confirma si termina, deshace si lanza. El cambio y su evento del outbox van juntos o no va ninguno. */
export async function inTransaction<T>(gateway: UnitOfWorkGateway, fn: (uow: WriteUnitOfWork) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const uow = await gateway.begin();
    try {
      const result = await fn(uow);
      await uow.commit();
      return result;
    } catch (err) {
      await uow.rollback();
      if (attempt >= MAX_ATTEMPTS || !gateway.isRetryable?.(err)) throw err;
      await new Promise((ok) => setTimeout(ok, 5 + Math.random() * 20 * attempt));
    }
  }
}

/** Nombre y correo de una persona de la organización (directorio interno de auth-service). null si no se pudo saber. */
export interface PeopleDirectory {
  contact(organizationId: string, userId: string): Promise<{ name: string | null; email: string | null } | null>;
}

export type Clock = () => Date;
export type IdGenerator = () => string;
