// ─────────────────────────────────────────────────────────────────────────────
// Tabla de transiciones válidas — la política de la máquina de estados.
//
// Los NOMBRES de estado están portados de atiende.ai
// (`src/lib/actions/state-machine.ts`, enum `ConversationStateEnum`), que hoy
// NO valida transiciones (solo lee/escribe `state` libremente — cualquier
// intent handler puede setear cualquier estado). Esa tabla de transiciones
// explícita es la pieza NUEVA que pide la fusión: "una transición inválida se
// rechaza, nunca se aplica parcialmente".
// ─────────────────────────────────────────────────────────────────────────────

export enum ConversationStateEnum {
  AWAITING_APPOINTMENT_DATE = 'awaiting_appointment_date',
  AWAITING_MODIFY_DATE = 'awaiting_modify_date',
  AWAITING_ORDER_CONFIRMATION = 'awaiting_order_confirmation',
  AWAITING_RESERVATION_DETAILS = 'awaiting_reservation_details',
  AWAITING_RESERVATION_CONFIRMATION = 'awaiting_reservation_confirmation',
  AWAITING_SURVEY_RESPONSE = 'awaiting_survey_response',
  AWAITING_APPOINTMENT_CONFIRMATION = 'awaiting_appointment_confirmation',
  RESERVATION_LOCKED_IN = 'reservation_locked_in',
}

export type BookingState = `${ConversationStateEnum}`;

/** `null` representa "sin flow multi-turno activo" (estado de reposo). */
export type TransitionTable<TState extends string> = Record<TState | '__null__', ReadonlySet<TState | null>>;

const S = ConversationStateEnum;

/**
 * Política por defecto para el flow genérico de reservación/cita/pedido.
 * Cualquier vertical (hoteles, restaurantes, citas-reservaciones, rentas)
 * puede extenderla o pasar su propia tabla al `ConversationStateMachine`.
 *
 * Regla de negocio codificada aquí: una vez `RESERVATION_LOCKED_IN` (el
 * INSERT real ya se hizo y pasó el chequeo de conflicto), la única
 * transición válida es volver a reposo (`null`) — nunca se puede "reabrir"
 * una reservación ya confirmada reescribiendo el estado por encima; eso
 * requiere un flow explícito de modificación (`AWAITING_MODIFY_DATE`) desde
 * reposo, no una transición directa.
 */
export const DEFAULT_BOOKING_TRANSITIONS: TransitionTable<BookingState> = {
  __null__: new Set<BookingState | null>([
    S.AWAITING_APPOINTMENT_DATE,
    S.AWAITING_MODIFY_DATE,
    S.AWAITING_ORDER_CONFIRMATION,
    S.AWAITING_RESERVATION_DETAILS,
    S.AWAITING_SURVEY_RESPONSE,
    S.AWAITING_APPOINTMENT_CONFIRMATION,
    null,
  ]),
  [S.AWAITING_APPOINTMENT_DATE]: new Set<BookingState | null>([
    // Self-loop: el cliente puede mandar varios mensajes seguidos dando
    // datos parciales ("el sábado" / "a las 5pm") sin salir del flow —
    // cada uno hace un `transition` al MISMO estado con un context patch
    // distinto. Necesario para que el CAS (compare-and-swap) tenga un caso
    // real de "reintento tras perder la carrera, la transición sigue
    // siendo válida, se reintenta y aplica el merge" en vez de rechazar
    // todo intento concurrente como si fuera un duplicado.
    S.AWAITING_APPOINTMENT_DATE,
    S.AWAITING_APPOINTMENT_CONFIRMATION,
    null,
  ]),
  [S.AWAITING_MODIFY_DATE]: new Set<BookingState | null>([null]),
  [S.AWAITING_ORDER_CONFIRMATION]: new Set<BookingState | null>([null]),
  [S.AWAITING_RESERVATION_DETAILS]: new Set<BookingState | null>([
    S.AWAITING_RESERVATION_DETAILS, // self-loop — ver comentario arriba
    S.AWAITING_RESERVATION_CONFIRMATION,
    null,
  ]),
  [S.AWAITING_RESERVATION_CONFIRMATION]: new Set<BookingState | null>([
    S.RESERVATION_LOCKED_IN,
    S.AWAITING_RESERVATION_DETAILS, // el cliente pidió cambiar algo antes de confirmar
    null,
  ]),
  [S.AWAITING_SURVEY_RESPONSE]: new Set<BookingState | null>([null]),
  [S.AWAITING_APPOINTMENT_CONFIRMATION]: new Set<BookingState | null>([null]),
  [S.RESERVATION_LOCKED_IN]: new Set<BookingState | null>([null]),
};

export function isValidTransition<TState extends string>(
  table: TransitionTable<TState>,
  from: TState | null,
  to: TState | null,
): boolean {
  const key = (from ?? '__null__') as TState | '__null__';
  const allowed = table[key];
  if (!allowed) return false;
  return allowed.has(to);
}
