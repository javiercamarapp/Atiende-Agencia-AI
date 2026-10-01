// H-27 -- ficha de huesped (CRM). Tipos y reglas puras. Sin I/O. Minimizacion de PII: la ficha muestra lo que el staff de
// reservas ya ve en el catalogo de huespedes (nombre, correo, telefono) mas el historial operativo; NUNCA el documento
// de identidad (vive solo en la boveda H-01) ni datos de tarjeta.
import type { ReservationStatus } from "../reservationStateMachine.ts";

export const GUEST_NOTE_KINDS = ["nota", "preferencia"] as const;
export type GuestNoteKind = (typeof GUEST_NOTE_KINDS)[number];
export const GUEST_NOTE_MAX_LENGTH = 500;

export interface GuestStayRow {
  readonly reservationId: string;
  readonly status: ReservationStatus;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly roomTypeName: string | null;
  readonly roomCode: string | null;
  /** Monto NETO de la estancia en centavos MXN enteros (la columna es numeric(12,2) en pesos). */
  readonly netAmountCents: number;
}

export interface GuestContactRequestRow {
  readonly id: string;
  readonly reason: string;
  readonly source: "voice" | "whatsapp";
  readonly message: string | null;
  readonly createdAt: string;
}

export interface GuestConsentRow {
  readonly id: string;
  readonly noticeVersion: string;
  readonly optionalPurposes: readonly string[];
  readonly channel: string;
  readonly consentedAt: string;
  readonly revoked: boolean;
}

export interface GuestNoteRecord {
  readonly id: string;
  readonly kind: GuestNoteKind;
  readonly body: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface GuestNotesResult {
  /** `false` si la migracion 038 aun no esta aplicada (lista vacia honesta, no "sin notas"). */
  readonly available: boolean;
  readonly items: readonly GuestNoteRecord[];
}

export interface GuestStaySummary {
  readonly stays: number;
  readonly nights: number;
  readonly lastStay: string | null;
  readonly nextArrival: string | null;
}

const COUNTED: ReadonlySet<ReservationStatus> = new Set(["check_in", "en_estancia", "check_out", "cerrada"]);

function nights(checkIn: string, checkOut: string): number {
  const ms = Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`);
  return ms > 0 ? Math.round(ms / 86_400_000) : 0;
}

/** Resumen del historial: solo cuentan estancias efectivas (con check-in); la proxima llegada es una confirmada futura. */
export function resumirEstancias(stays: readonly GuestStayRow[], today: string): GuestStaySummary {
  const efectivas = stays.filter((s) => COUNTED.has(s.status));
  const pasadas = efectivas.filter((s) => s.checkInDate <= today).map((s) => s.checkInDate).sort();
  const futuras = stays.filter((s) => s.status === "confirmada" && s.checkInDate >= today).map((s) => s.checkInDate).sort();
  return {
    stays: efectivas.length,
    nights: efectivas.reduce((acc, s) => acc + nights(s.checkInDate, s.checkOutDate), 0),
    lastStay: pasadas.length > 0 ? pasadas[pasadas.length - 1]! : null,
    nextArrival: futuras[0] ?? null,
  };
}

/** Ultimos 10 digitos del telefono: une un numero de WhatsApp (`5215511112222`) con el capturado en mostrador (`5511112222`). */
export function claveTelefono(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** Mismo criterio que la base (guest_note_guard): una nota no puede llevar una secuencia de 13 a 19 digitos (tarjeta/documento). */
export function notaTieneDatoSensible(body: string): boolean {
  return /[0-9]{13,19}/.test(body.replace(/[ -]/g, ""));
}

export class HuespedesNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} no encontrado.`);
    this.name = "HuespedesNotFoundError";
  }
}
export class HuespedesInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HuespedesInvalidInputError";
  }
}
/** El huesped ejercio cancelacion u oposicion (ARCO): no se agregan datos personales nuevos. */
export class HuespedesArcoRestrictionError extends Error {
  constructor() {
    super("El huesped tiene una solicitud ARCO de cancelacion u oposicion: no se pueden agregar notas ni preferencias.");
    this.name = "HuespedesArcoRestrictionError";
  }
}
export class HuespedesAccessDeniedError extends Error {
  constructor() {
    super("Tu rol no puede gestionar el CRM del huesped.");
    this.name = "HuespedesAccessDeniedError";
  }
}
/** La migracion 038 aun no esta aplicada (503 honesto, nunca 500). */
export class HuespedesUnavailableError extends Error {
  constructor(operation: string) {
    super(`No disponible aun: ${operation} requiere la migracion 038 (recepcion y ficha de huesped).`);
    this.name = "HuespedesUnavailableError";
  }
}
