// Extiende @atiende/core-auth::Errors con los códigos que este app necesita y que
// core-auth deliberadamente no conoce (negocio, no auth) — ver comentario de
// core-auth/src/errors.ts: "los errores de negocio de cada vertical siguen viviendo
// en apps/api, no en core-auth".
import { ApiError } from "@atiende/core-auth";

export const Errors = {
  unauthorized: (message = "Credenciales inválidas o token ausente/expirado.") => new ApiError(401, "unauthorized", message),
  forbidden: (message = "No tienes permiso para realizar esta acción.") => new ApiError(403, "forbidden", message),
  validation: (message: string) => new ApiError(400, "validation_error", message),
  notFound: (message = "No encontrado.") => new ApiError(404, "not_found", message),
  conflict: (message: string) => new ApiError(409, "conflict", message),
  tooManyRequests: (message = "Demasiadas solicitudes.") => new ApiError(429, "too_many_requests", message, { "Retry-After": "60" }),
  payloadTooLarge: (message = "Payload demasiado grande.") => new ApiError(413, "payload_too_large", message),
  serviceUnavailable: (message = "Servicio no configurado.") => new ApiError(503, "service_unavailable", message),
  // ---- hoteles (folios/cargos, ver diseño Fase 1 §4.1) ----
  idempotencyRequired: () => new ApiError(400, "idempotency_required", "Falta el header Idempotency-Key, obligatorio para esta operación de dinero."),
  idempotencyConflict: () => new ApiError(422, "idempotency_conflict", "El Idempotency-Key ya fue usado con un cuerpo de solicitud distinto."),
  impuestoNoCoincide: (calculado: number, recibido: number) =>
    new ApiError(422, "impuesto_no_coincide", `El impuesto calculado server-side (${calculado}) no coincide con el recibido (${recibido}).`),
  // ---- licitaciones (checklist/propuesta económica, ver diseño Fase 1 §4.1/§4.2) ----
  submissionDeadlineUnknown: (message: string) => new ApiError(422, "submission_deadline_unknown", message),
};
