// H-42 -- tipos del motor de reservas directo PUBLICO del hotel (web, sin login). La autoridad es la base (migracion 044 sobre 037):
// cotizacion con guardia de precio, holds sin sobreventa, anticipo, pago, estado y cancelacion. Dinero SIEMPRE en centavos enteros MXN.
import type { HoldRecord } from "../reservas-agente/tipos.ts";

export type PagoEstado = "no_requerido" | "pendiente" | "capturado" | "fallido" | "manual";
export type ReembolsoEstado = "no_aplica" | "solicitado" | "procesado";

/** Hold del canal web: el registro de 037 mas los datos de la reserva directa (migracion 044). */
export interface WebHoldRecord extends Omit<HoldRecord, "channel"> {
  readonly channel: "web";
  readonly guestEmail: string;
  readonly consentNoticeVersion: string;
  readonly depositCents: number;
  readonly paymentStatus: PagoEstado;
  readonly paymentRef: string | null;
  readonly canceledAt: string | null;
  readonly cancelPenaltyCents: number | null;
  readonly refundCents: number | null;
  readonly refundStatus: ReembolsoEstado | null;
}

export interface WebPolicyRecord {
  /** false = la migracion 044 aun no esta aplicada: la reserva publica responde "no disponible aun". */
  readonly disponible: boolean;
  readonly webEnabled: boolean;
  readonly holdsEnabled: boolean;
  /** 0..1: fraccion del total que se cobra como anticipo (0 = sin anticipo, queda para aprobacion humana). */
  readonly depositPct: number;
  readonly holdTtlMinutes: number;
  readonly maxNights: number;
  readonly maxGuests: number;
  readonly maxAdvanceDays: number;
  /** Terminos de cancelacion vigentes (null = el hotel no configuro ventana: sin penalidad). */
  readonly terminos: TerminosCancelacion | null;
}

/** Terminos de cancelacion vigentes del hotel (cancellation_policy). `null` = el hotel no configuro ventana: sin penalidad. */
export interface TerminosCancelacion {
  readonly freeUntilHours: number;
  readonly penaltyPct: number;
}

export interface WebHoldContext {
  readonly roomTypeName: string;
  readonly propertyName: string;
  /** Estado de la reserva real (hoteles.reservation) cuando el hold ya se confirmo. */
  readonly reservationStatus: string | null;
  readonly terminos: TerminosCancelacion | null;
}

export interface CreateWebHoldInput {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly guests: number;
  readonly guestName: string;
  readonly contactPhone: string;
  readonly contactEmail: string;
  readonly idempotencyKey: string;
  /** Total (centavos) que el huesped vio en la cotizacion firmada: la base lo contrasta con su propio calculo. */
  readonly expectedTotalCents: number;
  readonly consentNoticeVersion: string;
  readonly now?: Date;
}

export interface RoomNightsDirectas {
  /** false = la migracion 044 (columna reservation.channel) aun no esta aplicada. */
  readonly disponible: boolean;
  readonly desde: string;
  readonly hasta: string;
  readonly directas: number;
  readonly total: number;
  /** 0..1 redondeado a 4 decimales; null cuando no hay noches en el rango. */
  readonly porcentaje: number | null;
}
