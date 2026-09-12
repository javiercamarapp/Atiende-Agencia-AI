// Port ~literal de hoteles/packages/domain-hotel/src/reservationStateMachine.ts (H02).
// Máquina de estados de la reserva — espejo de aplicación de la autoridad real, que
// vive en Postgres (`hoteles.reservation_status_transition` + trigger
// `reservation_validate_transition`, ver migrations/005_reservas_estado.sql). Si este
// espejo se desincroniza de la tabla real, la peor consecuencia es un 403/409 de más
// en la ruta HTTP, nunca una transición inválida persistida — la autoridad final sigue
// siendo el trigger SQL, mismo criterio que overbooking.ts/quote.ts ya establecieron.
//
// Decisión de alcance (diseño Fase 3 §3.2): el enum completo (incluye `cotizada`) se
// porta por fidelidad al origen, aunque esta fase solo expone HTTP el subconjunto que
// pide el encargo — `POST crear` inserta directo en `confirmada`, saltando `cotizada`.
import type { HotelRole } from "./roles.ts";

export const RESERVATION_STATUSES = [
  "cotizada",
  "confirmada",
  "check_in",
  "en_estancia",
  "check_out",
  "cerrada",
  "cancelada",
  "no_show",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export function isReservationStatus(value: string): value is ReservationStatus {
  return (RESERVATION_STATUSES as readonly string[]).includes(value);
}

/** Tabla declarativa de transiciones válidas — mismo shape que
 *  `hoteles.reservation_status_transition` (fila por fila, no un CASE). Único punto
 *  donde este módulo decide qué transición existe. */
const VALID_TRANSITIONS: ReadonlyArray<readonly [ReservationStatus, ReservationStatus]> = [
  ["cotizada", "confirmada"],
  ["cotizada", "cancelada"],
  ["confirmada", "check_in"],
  ["confirmada", "cancelada"],
  ["confirmada", "no_show"],
  ["check_in", "en_estancia"],
  ["en_estancia", "check_out"],
  ["check_out", "cerrada"],
];

const TRANSITION_SET: ReadonlySet<string> = new Set(VALID_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

/** Roles de vertical (finos) permitidos por transición — política de APLICACIÓN, más
 *  fina que la RLS real (que solo exige `hoteles.can_manage_reservations()` para
 *  cualquier UPDATE de `status`, ver migrations/005). `"system"` es un actor lógico
 *  (nunca un rol de staff humano real, ver roles.ts::isHotelRole) reservado para el
 *  job automático de no-show — `canRolePerformTransition` lo acepta solo ahí. */
const ROLES_BY_TRANSITION: ReadonlyMap<string, readonly (HotelRole | "system")[]> = new Map([
  ["cotizada->confirmada", ["owner", "gm", "frontdesk", "reservations"]],
  ["cotizada->cancelada", ["owner", "gm", "frontdesk", "reservations"]],
  ["confirmada->check_in", ["owner", "gm", "frontdesk"]],
  ["confirmada->cancelada", ["owner", "gm", "frontdesk", "reservations"]],
  ["confirmada->no_show", ["owner", "gm", "frontdesk", "reservations", "system"]],
  ["check_in->en_estancia", ["owner", "gm", "frontdesk"]],
  ["en_estancia->check_out", ["owner", "gm", "frontdesk"]],
  ["check_out->cerrada", ["owner", "gm", "frontdesk", "accountant"]],
]);

/** true si (from,to) es una transición declarada en la tabla — misma pregunta que
 *  responde el trigger `reservation_validate_transition_trg` en Postgres. */
export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITION_SET.has(`${from}->${to}`);
}

/** `cotizada` o `confirmada` únicamente: después de `check_in` NO existe ninguna
 *  transición hacia `cancelada` en la tabla — verificado literal contra el origen, no
 *  supuesto (diseño Fase 3 §1). */
export function isCancellable(status: ReservationStatus): boolean {
  return status === "cotizada" || status === "confirmada";
}

/** Modificar fechas/tipo de habitación después de check-in tampoco existe en el
 *  origen — mismo criterio que `isCancellable`. Sin ruta HTTP en esta fase (§6), se
 *  porta para que una fase futura no tenga que reinventar el guardia. */
export function isModifiable(status: ReservationStatus): boolean {
  return status === "cotizada" || status === "confirmada";
}

/** Roles (de vertical, finos) que pueden ejecutar (from,to). Arreglo vacío si la
 *  transición ni siquiera es válida — nunca lanza, el llamador decide 400 vs 403. */
export function rolesAllowedForTransition(from: ReservationStatus, to: ReservationStatus): readonly (HotelRole | "system")[] {
  return ROLES_BY_TRANSITION.get(`${from}->${to}`) ?? [];
}

export function canRolePerformTransition(role: HotelRole | "system", from: ReservationStatus, to: ReservationStatus): boolean {
  return rolesAllowedForTransition(from, to).includes(role);
}

// ---------------------------------------------------------------------------
// Política de cancelación (`hoteles.cancellation_policy`, port de
// `hotel_cancellation_policy` del origen) — horas hasta check-in vs
// freeUntilHours/penaltyPct. Determinista: la única variable "de reloj" (`now`) SIEMPRE
// la pasa el llamador explícitamente (nunca `new Date()` interno), para que el cálculo
// sea reproducible en un test.
// ---------------------------------------------------------------------------
export interface CancellationPolicyConfig {
  /** Horas de anticipación (respecto a la fecha de check-in, 00:00 UTC) dentro de las
   *  cuales cancelar no tiene penalización. */
  readonly freeUntilHours: number;
  /** 0..1 — porcentaje del total de la reserva que se cobra como penalización cuando
   *  la cancelación ocurre DESPUÉS de la ventana libre. */
  readonly penaltyPct: number;
}

export interface CancellationEvaluationInput {
  readonly checkInDate: string; // YYYY-MM-DD
  readonly now: Date;
  readonly policy: CancellationPolicyConfig;
}

export interface CancellationEvaluationResult {
  readonly hoursUntilCheckIn: number;
  readonly penaltyPct: number;
}

/** Fechas UTC calendario puras (mismo criterio que `nightsBetween` en quote.ts) — evita
 *  que un horario de verano local distorsione las horas de anticipación. */
export function evaluateCancellation(input: CancellationEvaluationInput): CancellationEvaluationResult {
  const checkIn = new Date(`${input.checkInDate}T00:00:00Z`);
  const hoursUntilCheckIn = (checkIn.getTime() - input.now.getTime()) / (1000 * 60 * 60);
  const penaltyPct = hoursUntilCheckIn >= input.policy.freeUntilHours ? 0 : input.policy.penaltyPct;
  return { hoursUntilCheckIn, penaltyPct };
}
