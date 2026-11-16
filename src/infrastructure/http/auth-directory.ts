import type { PeopleDirectory } from '../../application/ports.js';

/**
 * Nombre y correo de quien escribe, del directorio interno de auth-service (`GET /internal/organizations/:id/contacts`, con
 * `X-Internal-Secret`; la misma ruta que usan notification-service y chat-service). Se copian al crear el envío (regla 3).
 */
export class AuthPeopleDirectory implements PeopleDirectory {
  constructor(private readonly baseUrl: string, private readonly internalSecret: string) {}

  async contact(organizationId: string, userId: string): Promise<{ name: string | null; email: string | null } | null> {
    if (!this.internalSecret) return null;
    const res = await fetch(`${this.baseUrl}/internal/organizations/${encodeURIComponent(organizationId)}/contacts`, {
      headers: { 'X-Internal-Secret': this.internalSecret },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { users?: Array<{ id?: unknown; email?: unknown; fullName?: unknown }> };
    const me = (body.users ?? []).find((u) => typeof u.id === 'string' && u.id.toLowerCase() === userId.toLowerCase());
    if (!me) return null;
    return { name: typeof me.fullName === 'string' && me.fullName ? me.fullName : null, email: typeof me.email === 'string' ? me.email : null };
  }
}
