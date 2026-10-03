// H-42 -- reglas puras de la reserva directa: guardia de precio, anticipo, vista publica de la disponibilidad (sin inventario exacto) y estado
// publico del hold. Todo en centavos enteros MXN. La base recalcula y valida de verdad (migracion 044): esto da el mismo resultado al espejo
// en memoria y arma lo que se muestra al huesped.
import { evaluateCancellation } from "../reservationStateMachine.ts";
import { sanitizeLabel } from "../reservas-agente/validacion.ts";
import type { StayOption } from "../reservas-agente/tipos.ts";
import type { PagoEstado, ReembolsoEstado, TerminosCancelacion, WebHoldContext, WebHoldRecord } from "./tipos.ts";

/** Guardia de precio: el total que el huesped vio debe ser EXACTAMENTE el vigente. Devuelve el vigente cuando difiere. */
export function verificarPrecio(esperadoCents: number, vigenteCents: number): { readonly ok: true } | { readonly ok: false; readonly vigenteCents: number } {
  return esperadoCents === vigenteCents ? { ok: true } : { ok: false, vigenteCents };
}

/** Anticipo = porcentaje del total, half-up, nunca mayor al total (mismo redondeo que la base). */
export function calcularAnticipo(totalCents: number, pct: number): number {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !(pct >= 0 && pct <= 1)) return 0;
  return Math.min(Math.floor(totalCents * pct + 0.5), totalCents);
}

export type MotivoNoDisponible = "sin_disponibilidad" | "estadia_minima" | "cerrado_en_estas_fechas" | "no_reservable_en_linea";

export interface OpcionPublica {
  readonly tipoHabitacionId: string;
  readonly nombre: string;
  readonly maxOcupacion: number;
  readonly disponible: boolean;
  readonly motivo: MotivoNoDisponible | null;
  /** Precio desde por noche, impuestos incluidos (total / noches, redondeado hacia arriba). null si no se puede reservar. */
  readonly desdePorNocheCentavos: number | null;
  readonly totalCentavos: number | null;
}

const MOTIVOS: Record<string, MotivoNoDisponible> = {
  sin_inventario: "sin_disponibilidad",
  estadia_minima_no_alcanzada: "estadia_minima",
  cerrado_a_llegada: "cerrado_en_estas_fechas",
  cerrado_a_salida: "cerrado_en_estas_fechas",
};

/** Vista publica: solo tipos que caben los huespedes, precio desde y un si/no de disponibilidad. NUNCA el inventario exacto ni los topes internos. */
export function opcionesPublicas(options: readonly StayOption[], nights: number, guests: number): readonly OpcionPublica[] {
  return options
    .filter((o) => o.maxOccupancy >= guests)
    .map((o): OpcionPublica => {
      const ok = o.status === "ok" && o.freeRooms > 0 && o.totalCents !== null;
      return {
        tipoHabitacionId: o.roomTypeId,
        nombre: sanitizeLabel(o.roomTypeName),
        maxOcupacion: o.maxOccupancy,
        disponible: ok,
        motivo: ok ? null : (MOTIVOS[o.status] ?? "no_reservable_en_linea"),
        desdePorNocheCentavos: ok ? Math.ceil((o.totalCents as number) / nights) : null,
        totalCentavos: ok ? (o.totalCents as number) : null,
      };
    });
}

export interface VistaCancelacion {
  /** ISO: hasta cuando se cancela sin penalidad (llegada 00:00 UTC menos la ventana). null = el hotel no configuro ventana. */
  readonly gratisHasta: string | null;
  readonly penalidadPct: number;
}

export function terminosPublicos(terminos: TerminosCancelacion | null, checkInDate: string): VistaCancelacion {
  if (!terminos) return { gratisHasta: null, penalidadPct: 0 };
  const llegada = Date.parse(`${checkInDate}T00:00:00Z`);
  return { gratisHasta: new Date(llegada - terminos.freeUntilHours * 3_600_000).toISOString(), penalidadPct: terminos.penaltyPct };
}

export interface PrevisionCancelacion {
  readonly penalidadCents: number;
  readonly reembolsoCents: number;
}

/** Misma regla que `hoteles.web_booking_cancel` (044): ventana medida contra la llegada a las 00:00 UTC; sin politica no hay penalidad. */
export function previsionCancelacion(input: { totalCents: number; pagadoCents: number; checkInDate: string; now: Date; terminos: TerminosCancelacion | null }): PrevisionCancelacion {
  const pct = input.terminos
    ? evaluateCancellation({ checkInDate: input.checkInDate, now: input.now, policy: { freeUntilHours: input.terminos.freeUntilHours, penaltyPct: input.terminos.penaltyPct } }).penaltyPct
    : 0;
  const penalidadCents = Math.floor(input.totalCents * pct + 0.5);
  return { penalidadCents, reembolsoCents: Math.max(input.pagadoCents - penalidadCents, 0) };
}

export type EstadoPublico = "pago_pendiente" | "en_revision" | "aprobada" | "confirmada" | "rechazada" | "expirada" | "cancelada";

/** Estado que ve el huesped (no expone nombres internos de la maquina de holds). */
export function estadoPublico(hold: Pick<WebHoldRecord, "status" | "canceledAt">, contexto: Pick<WebHoldContext, "reservationStatus">): EstadoPublico {
  if (hold.status === "cancelado" || hold.canceledAt !== null || contexto.reservationStatus === "cancelada") return "cancelada";
  switch (hold.status) {
    case "pendiente_pago": return "pago_pendiente";
    case "pendiente_aprobacion": return "en_revision";
    case "aprobado": return "aprobada";
    case "confirmado": return "confirmada";
    case "rechazado": return "rechazada";
    default: return "expirada";
  }
}

/** Se cancela en linea un hold abierto o una reserva confirmada aun sin check-in. */
export function esCancelable(hold: Pick<WebHoldRecord, "status" | "canceledAt">, contexto: Pick<WebHoldContext, "reservationStatus">): boolean {
  if (hold.canceledAt !== null) return false;
  if (hold.status === "pendiente_aprobacion" || hold.status === "pendiente_pago" || hold.status === "aprobado") return true;
  return hold.status === "confirmado" && contexto.reservationStatus === "confirmada";
}

/** Estado de pago hacia el huesped: nunca expone referencias de la pasarela. */
export function pagoPublico(paymentStatus: PagoEstado, refundStatus: ReembolsoEstado | null): { readonly estado: PagoEstado; readonly reembolso: ReembolsoEstado | null } {
  return { estado: paymentStatus, reembolso: refundStatus };
}
