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
  // ---- rentas (calendario/reservas, ver diseño Fase 1 rentas §4, Flujo 1) ----
  rentasUnidadNoDisponible: (conflictoId: string) =>
    new ApiError(409, "unidad_no_disponible", `La unidad no está disponible para el rango solicitado (conflicto registrado: ${conflictoId}).`),
  rentasReservaNoDirecta: () => new ApiError(409, "reserva_no_directa", "Esta reserva proviene de un canal externo: nunca se modifica/cancela desde aquí, solo reservas directas."),
  // ---- rentas (pricing CRUD, ver diseño Fase 2 rentas §3.6) ----
  rentasPricingSolapado: (nombreOtro: string, rango: { inicio: string; fin: string }) =>
    new ApiError(409, "pricing_solapado", `Se traslapa con "${nombreOtro}" (${rango.inicio}..${rango.fin}).`),
  rentasPricingMonedaInconsistente: (monedaExistente: string) =>
    new ApiError(400, "pricing_moneda_inconsistente", `La unidad ya tiene tarifas en "${monedaExistente}"; no se mezclan monedas por unidad.`),
  // ---- rentas (portal de propietario, ver diseño Fase 3 rentas §4/§5) ----
  rentasOwnerInviteTokenInvalido: () => new ApiError(400, "portal_invite_token_invalido", "El enlace de activación es inválido, ya fue usado, o expiró. Pide a tu gestora que te reenvíe la invitación."),
  // ---- hoteles (máquina de estados de reservas, ver diseño Fase 3 §5) ----
  reservaTransicionInvalida: (from: string, to: string) =>
    new ApiError(409, "transicion_invalida", `"${from}" -> "${to}" no es una transición válida de una reserva.`),
  reservaTransicionNoPermitidaPorRuta: (to: string) =>
    new ApiError(400, "transicion_no_permitida_por_ruta", `"${to}" tiene efectos secundarios propios (liberar inventario/penalización) y solo se ejecuta desde su ruta dedicada (/cancelar o el job de no-show), nunca desde la transición genérica.`),
  reservaNoCancelable: (status: string) =>
    new ApiError(409, "reserva_no_cancelable", `La reserva está en estado "${status}": ya no admite cancelación (después de check-in solo se sigue el flujo hasta check-out/cierre).`),
  reservaConflictoDeEstado: () =>
    new ApiError(409, "reserva_conflicto_estado", "La reserva ya cambió de estado (reintento/carrera); vuelve a consultarla antes de reintentar."),
  reservaSinDisponibilidad: (message: string) => new ApiError(409, "sin_disponibilidad", message),
  // ---- hoteles (CFDI de hospedaje, Fase 5 -- H5/REQ-BO-001/002) ----
  // Nuestro propio hotel es el EMISOR: a diferencia de despachos (ingesta un CFDI ya
  // timbrado por un tercero y solo lo marca `requiresHumanReview`), aquí un CFDI mal
  // formado nunca se envía a un PAC real -- se rechaza ANTES de intentar timbrar.
  cfdiHospedajeInvalido: (codigos: readonly string[]) =>
    new ApiError(422, "cfdi_hospedaje_invalido", `El CFDI de hospedaje no pasó la validación fiscal previa al timbrado: ${codigos.join(", ")}.`),
  // ---- despachos (cierre mensual, Fase 6 -- bloqueo de edición de movimientos ya cerrados) ----
  despachosPeriodoCerrado: (periodo: string) =>
    new ApiError(409, "periodo_cerrado", `El periodo ${periodo} ya está cerrado; no se pueden ingestar nuevos CFDI con fecha en ese periodo. Reabra el periodo primero.`),
  // ---- rentas (mensajería con huésped, Fase 7 -- borrador de IA + aprobación humana obligatoria) ----
  rentasMensajeAprobacionRequerida: (message: string) => new ApiError(409, "aprobacion_requerida", message),
  rentasMensajeExcedeLimite: (message: string) => new ApiError(422, "mensaje_excede_limite", message),
  rentasMensajeContenidoNoPermitido: (message: string) => new ApiError(422, "contenido_no_permitido", message),
  rentasMensajeTransicionInvalida: (message: string) => new ApiError(409, "transicion_no_permitida", message),
  rentasMensajeriaAgentesDeshabilitado: () =>
    new ApiError(503, "agentes_deshabilitado", "No hay un proveedor de IA configurado para este ambiente (LlmGateway ausente) — usa el generador determinista (usarIa:false) o configura un proveedor."),
  rentasMensajeriaSinPropuesta: (message: string) => new ApiError(422, "sin_propuesta_ia", message),
  rentasPlantillaNoAprobada: (message: string) => new ApiError(409, "plantilla_no_aprobada", message),
};
