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
  // ---- licitaciones (Fase 11 -- pipeline real de extracción de texto de PDF, ver
  // domain-licitaciones/text-extraction.ts): ningún documento subido produjo texto
  // extraíble (todos "requires_ocr"/"failed") -- fail-closed explícito, nunca se
  // procesa una matriz de requisitos vacía como si las bases no tuvieran requisitos.
  licitacionesNoExtractableDocuments: (skipped: readonly { documentLabel: string; status: string }[]) =>
    new ApiError(422, "no_extractable_documents", `Ningún documento produjo texto extraíble: ${skipped.map((s) => `"${s.documentLabel}" (${s.status})`).join("; ")}. Suba el texto ya extraído manualmente (campo "pages") o un archivo distinto -- no hay OCR de imagen disponible en este monorepo.`),
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
  // Fix hallazgo auditoría (rubro 6, ALTA) — `DualPacCfdiPort.timbrar` falla rápido
  // (`CfdiFolioStampingInProgressError`) en vez de esperar cuando otro proceso ya
  // tiene una reserva viva del mismo folio (dos requests concurrentes reales, o un
  // reintento del cliente mientras el anterior sigue en vuelo) -- se traduce a un
  // 409 explícito, nunca a un 500 genérico.
  cfdiTimbradoEnCurso: () =>
    new ApiError(409, "cfdi_timbrado_en_curso", "Ya hay un timbrado en curso para este folio (otra solicitud concurrente, o un reintento mientras la anterior sigue en proceso). Vuelve a intentar en unos segundos."),
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
  // ---- staff invite (Fase 10 — alta/gestión de cuentas de staff, genérico de core,
  // hoy solo expuesto vía las rutas de restaurantes, ver diseño en
  // packages/db/migrations/0002_staff_invite_schema.sql) ----
  staffInviteTokenInvalido: () =>
    new ApiError(400, "staff_invite_token_invalido", "La invitación es inválida, ya fue usada/revocada, o expiró. Pide que te reenvíen la invitación."),
  staffInviteRolInsuficiente: () =>
    new ApiError(403, "staff_invite_rol_insuficiente", "No puedes invitar a un rol con más alcance que el tuyo."),
  // Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
  // restaurantes permite gestionar roles desde el producto") — mismo umbral/mismo
  // código HTTP que `staffInviteRolInsuficiente`, mensaje propio para no confundir
  // "invitar" con "editar el rol de alguien ya aceptado" en la UI.
  staffRoleChangeRolInsuficiente: () =>
    new ApiError(403, "staff_role_change_rol_insuficiente", "No puedes cambiar el rol de alguien con más alcance que el tuyo, ni asignar un rol por encima del tuyo."),
  // FASE 3 (producto, restaurantes) — dar de baja a un staff YA ACEPTADO (ver
  // packages/db/migrations/0022_remove_membership.sql). Mismo umbral/mismo código
  // HTTP que `staffRoleChangeRolInsuficiente`, mensaje propio.
  staffRemovalRolInsuficiente: () =>
    new ApiError(403, "staff_removal_rol_insuficiente", "No puedes dar de baja a alguien con más alcance que el tuyo."),
  staffRemovalAutoBaja: () => new ApiError(400, "staff_removal_auto_baja", "No puedes darte de baja a ti mismo."),
  staffRemovalSinOwner: () =>
    new ApiError(400, "staff_removal_sin_owner", "No puedes dejar la organización sin ningún owner."),
  // ---- hoteles (motor de revenue management, Fase 9 -- REQ-REV-003/004/005/007) ----
  // El trigger real de Postgres (`revenue_engine_gate_transition_guard`) sigue siendo
  // la autoridad; esto solo traduce el mismo rechazo que `evaluateGateTransition`
  // (dominio puro) ya calculó ANTES de tocar la base, para no fingir un 500 genérico
  // cuando el gate bloquea una transición a propósito.
  revenueGateTransicionBloqueada: (razones: readonly string[]) =>
    new ApiError(409, "revenue_gate_transicion_bloqueada", razones.join(" | ")),
  revenueGateNoInicializado: () =>
    new ApiError(404, "revenue_gate_no_inicializado", 'El gate de revenue de esta property no está inicializado -- primero POST .../revenue/gate.'),
  // ---- citas (Fase 6 §2 seguimiento -- prueba de conexión real de Cal.com/
  // CalDAV, ver calendar-providers.ts::POST .../{calcom,caldav}/test-connection):
  // un error honesto por causa, nunca un 500 genérico envolviendo un fallo de red
  // o de credencial de un proveedor externo. ----
  citasCalendarProviderNoConectado: (plataforma: "calcom" | "caldav") =>
    new ApiError(409, "calendar_provider_no_conectado", `Este proveedor todavía no conectó ${plataforma === "calcom" ? "Cal.com" : "CalDAV"} -- conéctalo antes de probar la conexión.`),
  /** La credencial guardada (API key de Cal.com / contraseña de aplicación de
   * CalDAV) fue rechazada por el proveedor -- 401/403 real, o una referencia mal
   * configurada (404, ej. eventTypeId/colección que ya no existe). Un 4xx claro,
   * nunca un 500 -- el staff debe reconectar con credenciales/URL correctas. */
  citasCalendarProviderCredencialInvalida: (message: string) => new ApiError(422, "calendar_provider_credencial_invalida", message),
  /** El proveedor externo (Cal.com/el servidor CalDAV) no respondió o respondió con
   * un error del lado de ellos (5xx/timeout/red) -- 502, nunca un 500 genérico:
   * distingue "tu credencial está mal" de "el proveedor está caído ahora mismo". */
  citasCalendarProviderNoDisponible: (message: string) => new ApiError(502, "calendar_provider_no_disponible", message),
};
