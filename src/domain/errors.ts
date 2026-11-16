export interface ErrorDetail {
  field: string;
  message: string;
}

/** Error de negocio con su código y su estado HTTP. El formato de respuesta es el de todos los servicios: `{ code, message, details? }`. */
export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly httpStatus: number;
  readonly details?: ErrorDetail[];

  constructor(message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  readonly httpStatus = 422;
  constructor(details: ErrorDetail[], message = 'La petición no es válida.') {
    super(message, details);
  }
}

export class OrganizationContextRequiredError extends AppError {
  readonly code = 'ORG_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de organización.') { super(message); }
}

export class UserContextRequiredError extends AppError {
  readonly code = 'USER_CONTEXT_REQUIRED';
  readonly httpStatus = 401;
  constructor(message = 'Falta el contexto de usuario.') { super(message); }
}

export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;
  constructor(message = 'Solo el equipo de la plataforma puede hacer esto.') { super(message); }
}

/** Sin acceso = 404: no se confirma que existe un envío de otra persona u otra empresa (regla 6). */
export class FeedbackNotFoundError extends AppError {
  readonly code = 'FEEDBACK_NOT_FOUND';
  readonly httpStatus = 404;
  constructor(message = 'No encontramos ese envío.') { super(message); }
}

export class RateLimitedError extends AppError {
  readonly code = 'RATE_LIMITED';
  readonly httpStatus = 429;
  constructor(message = 'Ya mandaste varios en la última hora; espera un poco antes de mandar otro.') { super(message); }
}
