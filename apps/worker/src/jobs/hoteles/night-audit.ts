// Fase 6 hoteles (REQ-REV-013, H15-018/H16-003/H07-032) — PRIMER job real de
// apps/worker en todo el monorepo (las otras 5 verticales solo tienen el README
// reservado, ver apps/worker/README.md). Port ~conceptual de:
//   - hoteles/apps/api/src/jobs/nightAudit.ts (148L) -- `runNightAuditForProperty`
//   - hoteles/apps/api/src/jobs/nightAuditScheduler.ts (184L) -- `runNightAuditSweep`
//
// DECISIÓN DE MECANISMO DE INVOCACIÓN (documentada aquí porque es la primera vez que
// se decide para apps/worker en fusion):
//
//   apps/worker NO corre como proceso propio todavía -- no tiene servidor, no tiene
//   `setInterval` (a diferencia del origen, que sí arrancaba un scheduler EN PROCESO
//   dentro de apps/api/src/server.ts). En vez de construir esa infraestructura nueva
//   para este único job, este archivo expone SOLO la lógica de orquestación (I/O vía
//   `HotelesRepository`, nunca SQL/DbClient directo -- coherente con el resto de
//   domain-hoteles Fase 1-6) como funciones puras-de-efectos invocables, y
//   `apps/api/src/routes/verticals/hoteles/night-audit.ts` las expone por HTTP bajo
//   el MISMO patrón que ya usa `apps/api/src/routes/verticals/citas/reminders.ts`
//   (leído primero como plantilla, ver diseño Fase 1 citas §0.4): un endpoint interno
//   gateado por `x-atiende-internal-secret`, pensado para ser invocado por un cron
//   EXTERNO (Vercel Cron / Supabase Cron), no por un scheduler en proceso.
//
//   Por qué esto y no un `setInterval` en apps/worker: (1) apps/worker no tiene
//   todavía ni un `server.ts` ni un proceso long-lived que hospede ese timer -- crear
//   uno solo para este job sería más superficie nueva que reutilizar el patrón ya
//   aprobado y probado de citas; (2) un cron externo (Vercel/Supabase) ya resuelve
//   "ejecutar una vez al día" sin que fusion tenga que mantener su propio scheduler
//   de proceso, ni preocuparse por que sobreviva un restart/despliegue; (3) el mismo
//   secreto compartido (`INTERNAL_SECRET`) que ya protege el recordatorio de citas
//   se reutiliza tal cual, sin inventar un mecanismo de auth nuevo. La función de
//   este archivo queda además invocable en pruebas unitarias sin levantar HTTP.
//
// Idempotencia: `HotelesRepository.claimNightAuditRun`/`finishNightAuditRun`
// (packages/domain-hoteles/migrations/008) garantizan que una corrida por
// (property, business_date) SIEMPRE devuelve el resumen ya guardado en un segundo
// intento -- ver domain-hoteles/src/night-audit/engine.ts para la razón de no portar
// el advisory lock del origen literal.
import {
  DEFAULT_PROPERTY_TIMEZONE,
  buildNightAuditSummary,
  businessDateToClose,
  isPastNightAuditRunHour,
  planNightlyHospedajeCharges,
  type HotelesRepository,
  type NightAuditSummary,
} from "@atiende/domain-hoteles";
import { runNoShowSweep } from "./no-show.ts";

export interface RunNightAuditParams {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly businessDate: string;
}

/**
 * Corre (o recupera, si ya corrió) el night-audit de UNA property para UNA fecha de
 * negocio. Nunca postea dos veces (claim/finish), nunca inventa un monto faltante
 * (anomalías reportadas, no silenciadas), y la conciliación A&B/POS SIEMPRE queda
 * "sin_pos_configurado" (ADR-007: ninguna vertical de fusion tiene conector POS real
 * todavía).
 */
export async function runNightAuditForProperty(repo: HotelesRepository, params: RunNightAuditParams): Promise<NightAuditSummary> {
  const claim = await repo.claimNightAuditRun(params.organizationId, params.propertyId, params.businessDate);
  if (claim.status === "completado") {
    return { ...(claim.summary as unknown as NightAuditSummary), yaCompletado: true };
  }

  const taxConfig = await repo.loadTaxConfig(params.propertyId);

  // 1) Posteo de hospedaje de la noche — reservas en casa.
  const inHouse = await repo.listInHouseReservationsForNightAudit(params.propertyId, params.businessDate);
  const hospedajePlan = planNightlyHospedajeCharges(inHouse, taxConfig);
  const postedCharges: NightAuditSummary["postedCharges"][number][] = [];
  for (const decision of hospedajePlan.charges) {
    const posted = await repo.postNightlyHospedajeCharge({
      organizationId: params.organizationId,
      propertyId: params.propertyId,
      folioId: decision.folioId,
      businessDate: params.businessDate,
      netAmount: decision.netAmount,
      taxAmount: decision.taxAmount,
    });
    postedCharges.push({ reservationId: decision.reservationId, folioId: decision.folioId, amount: decision.netAmount, taxAmount: decision.taxAmount });
    void posted; // `isNew` no cambia lo que se reporta -- un cargo ya existente (retry) se reporta igual.
  }

  // 2) No-shows del día -- REUTILIZADO del mecanismo real de Fase 3
  //    (`POST /hoteles/:propertyId/reservas/procesar-no-show`), extraído a
  //    `runNoShowSweep` (ver night-audit/engine.ts §2 y el comentario de cabecera de
  //    no-show.ts) precisamente para que night-audit no lo reimplemente.
  const noShowResults = await runNoShowSweep(repo, { organizationId: params.organizationId, propertyId: params.propertyId, asOfDate: params.businessDate });
  const noShows: NightAuditSummary["noShows"][number][] = noShowResults.map((r) => ({ reservationId: r.reservationId, chargeAmount: r.penalizacionNeta }));

  // 3) Resumen de caja del día -- agrupado por fecha de negocio en la zona horaria de
  //    la property (ver `DEFAULT_PROPERTY_TIMEZONE`: sin columna de timezone propia
  //    todavía por property en `core.property`, gap declarado, no inventado).
  const cargosPorConcepto = await repo.sumChargesByConceptForBusinessDate(params.propertyId, params.businessDate, DEFAULT_PROPERTY_TIMEZONE);
  const pagosPorMetodo = await repo.sumPaymentsByMethodForBusinessDate(params.propertyId, params.businessDate, DEFAULT_PROPERTY_TIMEZONE);

  const summary = buildNightAuditSummary({
    businessDate: params.businessDate,
    propertyId: params.propertyId,
    postedCharges,
    noShows,
    anomalies: hospedajePlan.anomalies,
    cargosPorConcepto,
    pagosPorMetodo,
    enCasa: inHouse.length,
  });

  await repo.finishNightAuditRun(claim.id, summary as unknown as Record<string, unknown>);
  return summary;
}

export interface NightAuditSweepOptions {
  /** Hora local (0-23) a partir de la cual se considera "ya se puede cerrar el día
   *  anterior". Default 3 (03:00), mismo umbral que el origen. */
  readonly runHourLocal?: number;
  /** Reloj inyectable para pruebas deterministas -- default `Date.now` real. */
  readonly now?: () => Date;
}

export interface NightAuditSweepResult {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly ran: boolean;
  readonly skippedReason?: "fuera_de_horario";
  readonly businessDate?: string;
  readonly summary?: NightAuditSummary;
  readonly error?: string;
}

/**
 * Barrido de TODAS las properties de hoteles activas (`repo.listActiveHotelProperties`)
 * -- invocado por la ruta interna gateada por secreto (ver comentario de cabecera).
 * Un fallo en una property nunca detiene el resto (mismo criterio que
 * `citasRemindersRoutes`/`NightAuditScheduler.tick` del origen): se captura y se
 * reporta en `error`, la corrida de las demás continúa.
 */
export async function runNightAuditSweep(repo: HotelesRepository, options: NightAuditSweepOptions = {}): Promise<NightAuditSweepResult[]> {
  const runHourLocal = options.runHourLocal ?? 3;
  const now = (options.now ?? (() => new Date()))();
  const properties = await repo.listActiveHotelProperties();
  const results: NightAuditSweepResult[] = [];

  for (const property of properties) {
    // Sin columna de timezone por property (`core.property`) todavía -- se usa el
    // default declarado (ver `DEFAULT_PROPERTY_TIMEZONE`) para TODAS las properties
    // por ahora, documentado como gap explícito, no un dato inventado por property.
    if (!isPastNightAuditRunHour(now, DEFAULT_PROPERTY_TIMEZONE, runHourLocal)) {
      results.push({ organizationId: property.organizationId, propertyId: property.propertyId, ran: false, skippedReason: "fuera_de_horario" });
      continue;
    }
    const businessDate = businessDateToClose(now, DEFAULT_PROPERTY_TIMEZONE);
    try {
      const summary = await runNightAuditForProperty(repo, { organizationId: property.organizationId, propertyId: property.propertyId, businessDate });
      results.push({ organizationId: property.organizationId, propertyId: property.propertyId, ran: true, businessDate, summary });
    } catch (err) {
      results.push({
        organizationId: property.organizationId,
        propertyId: property.propertyId,
        ran: false,
        businessDate,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
