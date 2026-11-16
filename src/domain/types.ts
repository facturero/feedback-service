/** Quién actúa (cabeceras del gateway). */
export interface Actor {
  userId: string;
  organizationId: string;
  permissions: string[];
}

/** Permiso de plataforma (como `tax:manage`): solo lo reciben los `is_platform_admin` (auth-service, `PLATFORM_PERMISSIONS`). */
export const PLATFORM_PERMISSION = 'feedback:manage';
export const isPlatform = (actor: Actor) => actor.permissions.includes(PLATFORM_PERMISSION) || actor.permissions.includes('*');

export const FEEDBACK_KINDS = ['improvement', 'comment', 'problem'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_STATUSES = ['new', 'reviewing', 'accepted', 'implemented', 'declined'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Límites de texto (regla 7 de IMPLEMENTATION.md): es un buzón, no un sitio para pegar documentos. */
export const MAX_TITLE = 160;
export const MAX_BODY = 4000;
export const MAX_REASON = 200;

/**
 * Puntos que se sugieren al dueño al cambiar el estado (regla 10). Él confirma, cambia el monto o no da nada: es una sugerencia, no
 * algo automático (decisión del dueño: así nadie manda cosas solo por los puntos).
 */
export const SUGGESTED_POINTS: Partial<Record<FeedbackStatus, number>> = { accepted: 50, implemented: 200 };

export interface FeedbackItem {
  id: string;
  organizationId: string;
  /** Copia para mostrar (la manda el navegador; ningún servicio expone el nombre de la empresa). */
  organizationName: string | null;
  authorId: string;
  /** Copias del directorio de auth al crear: el dueño las ve aunque la persona cambie o se vaya. */
  authorName: string | null;
  authorEmail: string | null;
  kind: FeedbackKind;
  title: string;
  body: string;
  status: FeedbackStatus;
  /** Reportes de problemas: código de traza (cruce con SigNoz) y pantalla donde estaba. */
  traceId: string | null;
  urlPath: string | null;
  unreadByPlatform: boolean;
  unreadByAuthor: boolean;
  replyCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedbackReply {
  id: string;
  itemId: string;
  authorId: string;
  /** Respuesta del dueño de la plataforma (no de la persona que escribió). */
  fromPlatform: boolean;
  body: string;
  createdAt: Date;
}

export interface PointsEntry {
  id: string;
  organizationId: string;
  itemId: string | null;
  amount: number;
  reason: string;
  grantedBy: string;
  /** Clave del navegador: un doble clic no da los puntos dos veces (UNIQUE). */
  idempotencyKey: string;
  createdAt: Date;
}
