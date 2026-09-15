// Port literal de las clases de error de
// citas-reservaciones/supabase/functions/_shared/appointments-core.ts — mismo
// vocabulario, para que las rutas Hono de apps/api mapeen exactamente los mismos
// códigos HTTP que el origen (400 validación, 404 no encontrada, 409 conflicto).
export class AppointmentValidationError extends Error {}
export class AppointmentConflictError extends AppointmentValidationError {}
export class AppointmentNotFoundError extends AppointmentValidationError {}

/**
 * Hallazgo de auditoría (ALTO, "citas ignora :propertyId en su scoping"): un staff
 * con membership restringida a la sucursal A puede operar (cancelar/confirmar/
 * completar/marcar no-show/crear) una cita de la sucursal B de la MISMA
 * organización, porque las RPC `*_from_panel` (migrations/002, 010) solo
 * verificaban membership de ORGANIZACIÓN, nunca de property — igual de laxo que la
 * RLS de citas.appointments/providers antes de migrations/015. Deliberadamente NO
 * extiende AppointmentValidationError (que mapea a 400): un 403 real, distinto de
 * "no encontrada"/"formato inválido", para que la ruta lo traduzca con
 * `Errors.forbidden()`.
 */
export class AppointmentForbiddenError extends Error {}

/**
 * Un conflicto de horario (fuera de disponibilidad real, o el EXCLUDE USING gist
 * real de la base de datos rechazó el UPDATE porque alguien más tomó ese hueco
 * primero) que además trae alternativas REALES — calculadas con el mismo motor que
 * disponibilidad, nunca inventadas por el LLM — para que reagendar pueda decirle al
 * cliente "ese horario ya no, pero sí estos otros" en la misma respuesta.
 */
export class AppointmentAlternativesError extends AppointmentConflictError {
  constructor(
    message: string,
    readonly alternativeSlots: readonly { readonly startsAt: string; readonly endsAt: string }[],
  ) {
    super(message);
  }
}
