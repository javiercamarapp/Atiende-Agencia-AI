// Formato de error uniforme para el propio middleware de core-auth: {code, message},
// nunca un stack trace hacia el cliente. Subconjunto deliberadamente pequeño de
// `hoteles/apps/api/src/lib/errors.ts` — solo los códigos que ESTE paquete necesita
// para autenticación/autorización; los errores de negocio de cada vertical (conflictos
// de disponibilidad, límites de plan, etc.) siguen viviendo en `apps/api`, no aquí.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers?: Record<string, string>;

  constructor(status: number, code: string, message: string, headers?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export const Errors = {
  unauthorized: (message = "Credenciales inválidas o token ausente/expirado.") =>
    new ApiError(401, "unauthorized", message),
  forbidden: (message = "No tienes permiso para realizar esta acción.") => new ApiError(403, "forbidden", message),
  validation: (message: string) => new ApiError(400, "validation_error", message),
};
