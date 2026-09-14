// Fase 6 hoteles (REQ-REV-013, H15-018/H16-003/H07-032) — night audit propio,
// independiente del PMS del hotel. Port ~conceptual (no literal: el original vive en
// SQL/DbClient crudo sobre `public.*`, aquí el mismo comportamiento se separa en una
// capa PURA (este archivo) + el puerto de repositorio de HotelesRepository, mismo
// criterio que folioEngine.ts/reservationStateMachine.ts ya establecieron para el
// resto del dominio) de:
//   - hoteles/apps/api/src/jobs/nightAudit.ts (148L)
//   - hoteles/apps/api/src/jobs/nightAuditScheduler.ts (184L)
//
// Este módulo NUNCA hace I/O — decide, a partir de datos ya leídos por el llamador
// (apps/worker/src/jobs/hoteles/night-audit.ts), qué cargos de hospedaje se postean,
// qué reservas son no-show, y arma el resumen final. Extiende folioEngine.ts (nunca
// reimplementa `computeChargeAmounts`/`computeNoShowPenaltyAmounts`/
// `evaluateNoShowPenaltyBase`, ya existentes) — este archivo solo aporta la decisión
// NUEVA de night-audit: qué reservas entran al corte, cuáles tienen una anomalía de
// datos que impide postear honestamente (nunca se inventa un monto ni un folio), y
// cómo se arma el resumen de caja final.
import { computeChargeAmounts } from "../folioEngine.ts";
import type { TaxConfig } from "../taxes.ts";

// ─────────────────────────────────────────────────────────────────────────
// 1) Posteo de hospedaje de la noche — reservas "en casa" de `businessDate`.
// ─────────────────────────────────────────────────────────────────────────

/** Insumo de lectura para UNA reserva "en casa" la noche de `businessDate` (check-in
 *  ya hecho, check-out todavía no) — ya resuelto por el llamador contra
 *  `HotelesRepository.listInHouseReservationsForNightAudit()`. */
export interface InHouseReservationForNightAudit {
  readonly reservationId: string;
  /** `null` cuando la reserva "en casa" no tiene folio primario todavía — nunca
   *  debería pasar (`ensurePrimaryFolio` se llama al confirmar la reserva, Fase 3),
   *  pero si pasa, es un dato roto que el night-audit NUNCA ignora en silencio
   *  (verificación de "folio-cero" antes de postear/cerrar el día: ver
   *  `NightAuditAnomaly` abajo). */
  readonly folioId: string | null;
  /** Tarifa de esa noche exacta (`hoteles.rate_plan.price` para `businessDate`),
   *  `null` cuando no hay tarifa sembrada para esa fecha — el original (reference)
   *  posteaba $0 en ese caso; aquí se trata deliberadamente como anomalía en vez de
   *  inventar un monto de $0 (REQ-GOB-honestidad: "nunca se simulan/inventan
   *  datos"), documentado como desviación explícita del comportamiento original. */
  readonly nightlyPrice: number | null;
}

export type NightAuditAnomalyType = "folio_cero" | "sin_tarifa";

/** Reserva en casa que el night-audit NO pudo procesar honestamente — se reporta en
 *  el resumen (nunca se descarta en silencio), para que un humano investigue el dato
 *  roto (folio faltante o tarifa no sembrada) antes de que se repita otra noche. */
export interface NightAuditAnomaly {
  readonly reservationId: string;
  readonly type: NightAuditAnomalyType;
  readonly message: string;
}

export interface NightAuditChargeDecision {
  readonly reservationId: string;
  readonly folioId: string;
  readonly netAmount: number;
  readonly taxAmount: number;
}

export interface NightAuditHospedajePlan {
  readonly charges: readonly NightAuditChargeDecision[];
  readonly anomalies: readonly NightAuditAnomaly[];
}

/** Decide, para cada reserva en casa, si se postea un cargo de hospedaje o si es una
 *  anomalía — PURO, nunca escribe nada. El llamador postea `charges` vía
 *  `HotelesRepository.postNightlyHospedajeCharge()` (idempotente por
 *  `charge_folio_stay_date_hospedaje_idx`, migrations/001) y reporta `anomalies` tal
 *  cual en el resumen. */
export function planNightlyHospedajeCharges(
  reservations: readonly InHouseReservationForNightAudit[],
  taxConfig: TaxConfig,
): NightAuditHospedajePlan {
  const charges: NightAuditChargeDecision[] = [];
  const anomalies: NightAuditAnomaly[] = [];

  for (const r of reservations) {
    if (r.folioId == null) {
      anomalies.push({
        reservationId: r.reservationId,
        type: "folio_cero",
        message: `La reserva ${r.reservationId} está en casa pero no tiene folio primario -- no se posteó hospedaje (verificación de folio-cero).`,
      });
      continue;
    }
    if (r.nightlyPrice == null) {
      anomalies.push({
        reservationId: r.reservationId,
        type: "sin_tarifa",
        message: `La reserva ${r.reservationId} no tiene tarifa sembrada para esta noche -- no se posteó hospedaje (nunca se inventa un monto).`,
      });
      continue;
    }
    const calc = computeChargeAmounts({ concept: "hospedaje", netAmount: r.nightlyPrice, taxConfig });
    charges.push({ reservationId: r.reservationId, folioId: r.folioId, netAmount: calc.netAmount, taxAmount: calc.taxAmount });
  }

  return { charges, anomalies };
}

// ─────────────────────────────────────────────────────────────────────────
// 2) No-shows del día — REUTILIZADO, no reimplementado: Fase 3 (H02/REQ-RES-008) ya
//    construyó el mecanismo completo (reclamo atómico + liberar disponibilidad +
//    `evaluateNoShowPenaltyBase`/`computeNoShowPenaltyAmounts` + postear al folio
//    primario) como `POST /hoteles/:propertyId/reservas/procesar-no-show`. Ese
//    mecanismo se extrajo a `apps/worker/src/jobs/hoteles/no-show.ts::runNoShowSweep`
//    (mismo I/O real vía HotelesRepository) para que TANTO esa ruta COMO
//    `night-audit.ts` lo llamen -- night-audit nunca vuelve a calcular una
//    penalización de no-show por su cuenta. Ver el comentario de cabecera de
//    `no-show.ts` para el detalle completo.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// 3) Resumen final — mismo shape que el original (`NightAuditSummary`), con
//    `anomalias` sumado (ver arriba) y `conciliacionAB` SIEMPRE "sin_pos_configurado"
//    (ADR-007 del origen: ninguna vertical de fusion tiene conector POS/A&B real
//    todavía -- fail-closed, nunca se simula una cifra de conciliación).
// ─────────────────────────────────────────────────────────────────────────

export interface NightAuditSummary {
  readonly businessDate: string;
  readonly propertyId: string;
  readonly postedCharges: readonly { reservationId: string; folioId: string; amount: number; taxAmount: number }[];
  readonly noShows: readonly { reservationId: string; chargeAmount: number }[];
  readonly anomalies: readonly NightAuditAnomaly[];
  readonly cargosPorConcepto: Readonly<Record<string, number>>;
  readonly pagosPorMetodo: Readonly<Record<string, number>>;
  readonly ocupacion: { readonly enCasa: number };
  readonly conciliacionAB: { readonly estado: "sin_pos_configurado" };
  readonly yaCompletado: boolean;
}

export function buildNightAuditSummary(input: {
  readonly businessDate: string;
  readonly propertyId: string;
  readonly postedCharges: readonly { reservationId: string; folioId: string; amount: number; taxAmount: number }[];
  readonly noShows: readonly { reservationId: string; chargeAmount: number }[];
  readonly anomalies: readonly NightAuditAnomaly[];
  readonly cargosPorConcepto: Readonly<Record<string, number>>;
  readonly pagosPorMetodo: Readonly<Record<string, number>>;
  readonly enCasa: number;
}): NightAuditSummary {
  return {
    businessDate: input.businessDate,
    propertyId: input.propertyId,
    postedCharges: input.postedCharges,
    noShows: input.noShows,
    anomalies: input.anomalies,
    cargosPorConcepto: input.cargosPorConcepto,
    pagosPorMetodo: input.pagosPorMetodo,
    ocupacion: { enCasa: input.enCasa },
    conciliacionAB: { estado: "sin_pos_configurado" },
    yaCompletado: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 4) Planificador — port ~literal (puro, sin I/O) de
//    `nightAuditScheduler.ts::businessDateToClose`/`localHour`. Sin columna
//    `timezone` propia por property todavía en `core.property` (gap declarado, no
//    inventado: a diferencia del origen, `core.property` de atiende-fusion no trae
//    zona horaria por tenant) -- `DEFAULT_PROPERTY_TIMEZONE` es el default explícito
//    hasta que una fase futura agregue esa columna; cualquier caller puede pasar un
//    timezone real ya resuelto por otro medio sin tocar esta función.
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_PROPERTY_TIMEZONE = "America/Mexico_City";

/** Fecha de negocio a cerrar: el día ANTERIOR a "hoy", en la zona horaria dada --
 *  nunca UTC del servidor a secas. */
export function businessDateToClose(nowUtc: Date, timezone: string = DEFAULT_PROPERTY_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(nowUtc);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const localAsUtcMidnight = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  localAsUtcMidnight.setUTCDate(localAsUtcMidnight.getUTCDate() - 1);
  return localAsUtcMidnight.toISOString().slice(0, 10);
}

/** Hora local (0-23) en la zona horaria dada, en este instante. */
export function localHour(nowUtc: Date, timezone: string = DEFAULT_PROPERTY_TIMEZONE): number {
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).format(nowUtc);
  return Number(formatted) % 24;
}

/** true si, a esta hora, ya se puede cerrar el día anterior (después de medianoche,
 *  con margen para checkouts/cargos tardíos) -- mismo umbral por default que el
 *  original (03:00 hora local). */
export function isPastNightAuditRunHour(nowUtc: Date, timezone: string = DEFAULT_PROPERTY_TIMEZONE, runHourLocal = 3): boolean {
  return localHour(nowUtc, timezone) >= runHourLocal;
}
