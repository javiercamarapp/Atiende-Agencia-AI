// H-25 -- tipos y errores de dominio del agente de reservas (WhatsApp y voz). La autoridad es la base (migracion 037: cotizacion
// con guardia de precio, holds sin sobreventa, politica por hotel): estos tipos describen lo que ella devuelve. Dinero SIEMPRE
// en centavos enteros MXN.

export const HOLD_OPEN_STATUSES = ["pendiente_aprobacion", "pendiente_pago", "aprobado"] as const;
export const HOLD_STATUSES = [...HOLD_OPEN_STATUSES, "confirmado", "rechazado", "expirado", "cancelado"] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];
export type HoldMode = "aprobacion_humana" | "link_pago";
export type HoldChannel = "whatsapp" | "voz";

/** Roles que deciden/confirman/cancelan un hold (espejo de booking_hold_lock en la migracion 037). */
export const HOLD_DECISION_ROLES = ["owner", "gm", "reservations"] as const;
/** Roles que ven holds y politica (can_view_agents). */
export const HOLD_VIEW_ROLES = ["owner", "gm", "frontdesk", "reservations", "accountant"] as const;
/** Roles que escriben la politica (can_manage_agents). */
export const HOLD_POLICY_ROLES = ["owner", "gm"] as const;

export type StayOptionStatus =
  | "ok"
  | "sin_inventario"
  | "sin_tarifa"
  | "cerrado_a_llegada"
  | "cerrado_a_salida"
  | "estadia_minima_no_alcanzada"
  | "precio_fuera_de_guardia"
  | "moneda_no_soportada";

export interface NightlyPrice {
  readonly date: string;
  readonly cents: number;
}

export interface StayOption {
  readonly roomTypeId: string;
  readonly roomTypeName: string;
  readonly maxOccupancy: number;
  /** Habitaciones libres SIN sobreventa (total - booked) en la noche mas apretada. */
  readonly freeRooms: number;
  readonly status: StayOptionStatus;
  /** Solo cuando status = 'ok'. */
  readonly netCents: number | null;
  readonly ivaCents: number | null;
  readonly ishCents: number | null;
  readonly totalCents: number | null;
  readonly nightly: readonly NightlyPrice[] | null;
}

export interface StayOptionsResult {
  /** false = la migracion 037 aun no esta aplicada: vacio honesto, el agente deriva a una persona. */
  readonly disponible: boolean;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly nights: number;
  readonly opciones: readonly StayOption[];
}

export interface HoldRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly nights: number;
  readonly guests: number;
  readonly channel: HoldChannel;
  readonly guestName: string | null;
  readonly contactPhone: string;
  readonly currency: "MXN";
  readonly netCents: number;
  readonly ivaCents: number;
  readonly ishCents: number;
  readonly totalCents: number;
  readonly mode: HoldMode;
  readonly status: HoldStatus;
  readonly expiresAt: string;
  readonly paymentLinkRef: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly reservationId: string | null;
  readonly createdAt: string;
}

export interface HoldListResult {
  readonly disponible: boolean;
  readonly holds: readonly HoldRecord[];
}

export interface BookingPolicyRecord {
  readonly propertyId: string;
  readonly holdsEnabled: boolean;
  readonly mode: HoldMode;
  readonly holdTtlMinutes: number;
  readonly maxNights: number;
  readonly maxGuests: number;
  readonly maxAdvanceDays: number;
  readonly maxActiveHolds: number;
  /** false = no hay fila: rigen los valores por defecto con holds DESHABILITADOS. */
  readonly configured: boolean;
}

export type BookingPolicyInput = Omit<BookingPolicyRecord, "propertyId" | "configured">;

export interface BookingPolicyResult {
  readonly disponible: boolean;
  readonly politica: BookingPolicyRecord;
}

export interface CreateHoldInput {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly guests: number;
  readonly guestName: string | null;
  readonly contactPhone: string;
  readonly channel: HoldChannel;
  readonly idempotencyKey: string;
  /** Total que el huesped vio (de la cotizacion vigente): la base lo contrasta con su propio calculo. */
  readonly expectedTotalCents: number;
  /** Reloj de la app; la base solo lo respeta en sesion de sistema (pruebas). */
  readonly now?: Date;
}

export type DefaultPolicy = Omit<BookingPolicyRecord, "propertyId" | "configured">;
export const DEFAULT_BOOKING_POLICY: DefaultPolicy = {
  holdsEnabled: false,
  mode: "aprobacion_humana",
  holdTtlMinutes: 120,
  maxNights: 14,
  maxGuests: 6,
  maxAdvanceDays: 365,
  maxActiveHolds: 40,
};

/** Error de regla de negocio con codigo estable (el agente lo traduce a un mensaje seguro para el huesped). */
export class ReservasAgenteError extends Error {
  constructor(
    public readonly code: ReservasAgenteErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ReservasAgenteError";
  }
}

export type ReservasAgenteErrorCode =
  | "sin_disponibilidad"
  | "precio_cambio"
  | "fechas_invalidas"
  | "fecha_pasada"
  | "fecha_muy_lejana"
  | "estadia_muy_larga"
  | "holds_deshabilitados"
  | "limite_holds_activos"
  | "limite_holds_contacto"
  | "huespedes_invalidos"
  | "cotizacion_no_disponible"
  | "tipo_habitacion_invalido"
  | "parametros_invalidos"
  | "idempotencia_conflicto"
  | "no_encontrada"
  | "estado_no_valido"
  | "sin_permiso"
  | "no_disponible_aun";

export class ReservasAgenteUnavailableError extends ReservasAgenteError {
  constructor(public readonly operation: string) {
    super("no_disponible_aun", `Agente de reservas: la migracion 037 aun no esta aplicada (${operation}).`);
    this.name = "ReservasAgenteUnavailableError";
  }
}
