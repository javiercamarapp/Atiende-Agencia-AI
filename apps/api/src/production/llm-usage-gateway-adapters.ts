// Adaptadores REALES de los dos puertos que `packages/agent-core/src/gateway`
// expone para el control de gasto de API de LLM del back office de
// plataforma (`UsageRecorder`/`OrgMonthlyBudgetStore`, agnósticos de Postgres
// a propósito — ver el comentario de cabecera de esos archivos), consumidos
// por `production/llm-gateway.ts` al construir el `LlmGateway` real.
//
// Ambos abren su PROPIA sesión de SISTEMA (`engine.withAppSession({userId:
// null}, ...)`) en cada llamada, MISMO patrón que
// `ProductionDespachosAuditSink`/`ProductionHotelesFraudeAuditSink`: el
// `LlmGateway` es un singleton de proceso que vive fuera de cualquier
// transacción por-request (lo comparten las 8 escaleras de las 6 verticales,
// ver `llm-gateway.ts`), así que no hay ningún `TenantDbSession` por-request
// que reutilizar aquí — las funciones SQL que invoca
// (`core.record_llm_usage`/`core.reserve_llm_monthly_budget`/
// `core.settle_llm_monthly_budget`) son `security definer` internas, sin
// `p_caller_id` (ver la migración), exactamente igual que
// `despachos.record_audit_log`.
//
// DOS criterios de fallo DISTINTOS, a propósito:
//   - `ProductionLlmUsageRecorder` (observacional) — NUNCA lanza, mismo
//     contrato que `AuditSink.record` (ver despachos-audit-sink.ts): un
//     Postgres caído aquí pierde una fila de auditoría de gasto, nunca tumba
//     ni retrasa con un error una llamada al LLM que ya tuvo éxito (el
//     gateway YA la envuelve en su propio try/catch antes de llamar aquí —
//     ver gateway.ts — pero esta clase no depende de eso, es defensa en
//     profundidad).
//   - `ProductionOrgMonthlyBudgetStore.reserve` (autoritativo) — SÍ propaga
//     cualquier error (incluido un Postgres caído): "reserva-antes-de-gastar"
//     significa que si no se puede verificar el tope, la llamada NO procede
//     (fail-closed) — igual criterio que `reserveBudget`/`budgetStore` ya
//     establecido en gateway.ts, nunca un catch silencioso que dejaría pasar
//     gasto sin control real. `settle` (ajuste post-hoc al costo real) SÍ es
//     best-effort — el gateway ya lo envuelve en `.catch(() => {})`.
import { LlmMonthlyBudgetExceededError, PostgresLlmUsageRepository, emitirNotificacion, isMigrationPendingError, type LlmMonthlyReservationTotals } from "@atiende/db";
import { avisarPresupuestoIaAlDuenio } from "@atiende/domain-restaurantes";
import type { UmbralPresupuestoIa } from "@atiende/domain-restaurantes";
import { MonthlyBudgetExceededError, RoleDailyTurnLimitExceededError, type LlmUsageEvent, type OrgMonthlyBudgetStore, type RoleDailyTurnStore, type UsageRecorder } from "@atiende/agent-core";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { defaultRoleDailyTurnLimit } from "./llm-role-limits.ts";

/** Umbral de aviso del gasto de IA (porcentaje del tope mensual de una organizacion o de la plataforma). */
export const UMBRAL_AVISO_GASTO_IA_PCT = 80;
/** Respaldo alto: minimo de llamadas en la hora para evaluar el porcentaje (con pocas llamadas un solo respaldo ya pasaria el 5 %). */
export const FALLBACK_VENTANA_MIN_LLAMADAS = 20;
/** Porcentaje de llamadas de la hora que cayeron a un modelo de respaldo a partir del cual se avisa (estrictamente mayor). */
export const FALLBACK_UMBRAL_PCT = 5;

/** Cuanto dura la memoria de "la base aun no tiene la 0047". Pasado ese tiempo se vuelve a intentar: tras aplicar la migracion, las instancias
 *  calientes recuperan subtope, tope diario y ventana sin esperar a reciclarse. */
export const MIGRACION_PENDIENTE_TTL_MS = 60_000;

/** Bandera "base sin migrar" que EXPIRA (en vez de quedar pegada por instancia). */
export class BanderaConTtl {
  private hasta = 0;
  constructor(private readonly ttlMs: number = MIGRACION_PENDIENTE_TTL_MS, private readonly ahora: () => number = Date.now) {}
  get activa(): boolean { return this.ahora() < this.hasta; }
  marcar(): void { this.hasta = this.ahora() + this.ttlMs; }
}

/** Claves de dedupe de los avisos al 80 % tras una reserva exitosa (una por organizacion/mes y una de plataforma/mes). Funcion pura. */
export function clavesAvisoUmbral(organizationId: string, totals: LlmMonthlyReservationTotals, ahora: Date): string[] {
  const mes = ahora.toISOString().slice(0, 7);
  const claves: string[] = [];
  if (totals.orgCapMicroUsd > 0 && (totals.orgTotalMicroUsd * 100) / totals.orgCapMicroUsd >= UMBRAL_AVISO_GASTO_IA_PCT) claves.push(`org:${organizationId}:${UMBRAL_AVISO_GASTO_IA_PCT}:${mes}`);
  if (totals.platformCapMicroUsd > 0 && (totals.platformTotalMicroUsd * 100) / totals.platformCapMicroUsd >= UMBRAL_AVISO_GASTO_IA_PCT) claves.push(`plataforma:${UMBRAL_AVISO_GASTO_IA_PCT}:${mes}`);
  return claves;
}

/** Clave de dedupe del aviso de respaldo alto: una por hora calendario (UTC). */
export function claveAvisoFallback(ahora: Date): string {
  return ahora.toISOString().slice(0, 13);
}

/** true si la ventana de la hora justifica avisar: suficientes llamadas y mas del 5 % cayo a un modelo de respaldo. Funcion pura. */
export function fallbackSuperaUmbral(calls: number, fallbacks: number): boolean {
  return calls >= FALLBACK_VENTANA_MIN_LLAMADAS && fallbacks * 100 > calls * FALLBACK_UMBRAL_PCT;
}

/** Aviso in-app a los superadmins al llegar al 80 % de un tope mensual (de organizacion o de plataforma). Sin PII: solo el
 *  porcentaje. Dedupe por organizacion/mes/umbral en la base; `emitidoEn` evita abrir una sesion por cada reserva de la misma
 *  instancia. Best-effort: nunca lanza ni cambia el resultado de la reserva. */
export async function notificarUmbralIaBestEffort(engine: TenancyEngine, emitidoEn: Set<string>, clave: string, porcentaje: number): Promise<void> {
  if (emitidoEn.has(clave)) return;
  try {
    const res = await engine.withAppSession({ userId: null }, (session) =>
      emitirNotificacion(session, { evento: "superadmin.costo.ia_umbral", organizationId: null, clave, parametros: { porcentaje } }),
    );
    if (res.estado === "emitida" || res.estado === "sin_nuevas") emitidoEn.add(clave);
  } catch {
    // best-effort
  }
}

/** Aviso in-app al DUEÑO (owner/admin de una organizacion de restaurantes) de que su presupuesto mensual de IA llego al 80 % o se agoto (100 %). Va junto al
 *  aviso de superadmin, no en su lugar. Sin PII: solo el porcentaje. `emitidoEn` evita abrir una sesion por cada reserva de la misma instancia; el dedupe
 *  real (una por umbral y mes) vive en la base. Best-effort: nunca lanza ni cambia el resultado de la reserva. */
export async function notificarPresupuestoIaDuenioBestEffort(engine: TenancyEngine, emitidoEn: Set<string>, organizationId: string, porcentaje: UmbralPresupuestoIa, ahora: Date = new Date(), sinMigrar?: BanderaConTtl): Promise<void> {
  const clave = `${organizationId}:${porcentaje}:${ahora.toISOString().slice(0, 7)}`;
  if (emitidoEn.has(clave)) return;
  // Base sin la 052: el resultado seria `no_disponible` en cada reserva; la bandera con TTL evita abrir una sesion de sistema extra hasta que se migre.
  if (sinMigrar?.activa) return;
  try {
    const estado = await engine.withAppSession({ userId: null }, (session) => avisarPresupuestoIaAlDuenio(session, { organizationId, porcentaje, now: ahora }));
    // Solo se recuerda si la base lo proceso (o no aplica); un `no_disponible` marca la bandera con TTL (se reintenta al vencer) y un `error` se reintenta en la siguiente llamada.
    if (estado === "no_disponible") sinMigrar?.marcar();
    if (estado === "emitida" || estado === "sin_nuevas" || estado === "no_aplica") emitidoEn.add(clave);
  } catch {
    // best-effort
  }
}

/** Aviso in-app cuando mas del 5 % de las llamadas de la hora cayeron a un modelo de respaldo (`superadmin.llm.fallback_alto`). */
export async function notificarFallbackAltoBestEffort(engine: TenancyEngine, emitidoEn: Set<string>, ahora: Date, porcentaje: number): Promise<void> {
  const clave = claveAvisoFallback(ahora);
  if (emitidoEn.has(clave)) return;
  try {
    const res = await engine.withAppSession({ userId: null }, (session) =>
      emitirNotificacion(session, { evento: "superadmin.llm.fallback_alto", organizationId: null, clave, parametros: { porcentaje: Math.round(porcentaje) } }),
    );
    if (res.estado === "emitida" || res.estado === "sin_nuevas") emitidoEn.add(clave);
  } catch {
    // best-effort
  }
}

export class ProductionLlmUsageRecorder implements UsageRecorder {
  private readonly ventanaNoDisponible = new BanderaConTtl();
  private readonly fallbackAvisado = new Set<string>();

  constructor(private readonly engine: TenancyEngine) {}

  /** Ventana horaria de respaldos (migracion 0047): cuenta la llamada y avisa si mas del 5 % de la hora cayo a un modelo de respaldo.
   *  Corre en su PROPIA sesion de sistema y es best-effort: nunca lanza ni toca el registro de uso de arriba. */
  private async registrarVentana(fallbackUsed: boolean): Promise<void> {
    if (this.ventanaNoDisponible.activa) return;
    try {
      const w = await this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).recordHourWindow(fallbackUsed));
      if (fallbackSuperaUmbral(w.calls, w.fallbacks)) await notificarFallbackAltoBestEffort(this.engine, this.fallbackAvisado, new Date(), (w.fallbacks * 100) / w.calls);
    } catch (err) {
      if (isMigrationPendingError(err)) this.ventanaNoDisponible.marcar(); // base sin migrar (0047): sin ventana, nunca un error
    }
  }

  async record(event: LlmUsageEvent): Promise<void> {
    await this.registrarVentana(event.fallbackUsed);
    try {
      await this.engine.withAppSession({ userId: null }, (session) =>
        new PostgresLlmUsageRepository(session).recordUsage({
          organizationId: event.organizationId,
          vertical: event.vertical,
          role: event.role,
          providerId: event.providerId,
          model: event.model,
          lane: event.lane,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          ...(event.tokensCached !== undefined ? { tokensCached: event.tokensCached } : {}),
          ...(event.tokensReasoning !== undefined ? { tokensReasoning: event.tokensReasoning } : {}),
          costMicroUsd: event.costMicroUsd,
          fallbackUsed: event.fallbackUsed,
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "llm_usage_recorder_write_failed",
          message: err instanceof Error ? err.message : String(err),
          organization_id: event.organizationId,
          role: event.role,
          provider_id: event.providerId,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}

/** Notificacion in-app a los superadmins cuando un tope MENSUAL de gasto de IA (de organizacion o de plataforma) se
 *  agota (`superadmin.costo.ia_umbral`, umbral 100; sin PII: solo el porcentaje). Dedupe por mes en la base; el
 *  `emitidoEn` evita abrir una sesion por cada llamada rechazada del mismo mes en esta instancia. Best-effort: nunca
 *  lanza ni cambia el error de presupuesto que ya se propaga. */
export async function notificarTopeIaAgotadoBestEffort(engine: TenancyEngine, emitidoEn: Set<string>, ahora: Date = new Date()): Promise<void> {
  const clave = `100:${ahora.toISOString().slice(0, 7)}`;
  if (emitidoEn.has(clave)) return;
  try {
    const res = await engine.withAppSession({ userId: null }, (session) =>
      emitirNotificacion(session, { evento: "superadmin.costo.ia_umbral", organizationId: null, clave, parametros: { porcentaje: 100 } }),
    );
    // Solo se recuerda si la base lo proceso (o ya existia); un `no_disponible`/`error` se reintenta en la siguiente llamada.
    if (res.estado === "emitida" || res.estado === "sin_nuevas") emitidoEn.add(clave);
  } catch {
    // best-effort
  }
}

export class ProductionOrgMonthlyBudgetStore implements OrgMonthlyBudgetStore {
  private readonly topeNotificado = new Set<string>();
  private readonly umbralNotificado = new Set<string>();
  private readonly duenioNotificado = new Set<string>();
  /** La base aun no tiene la 052 (aviso al dueno): se deja de abrir una sesion extra por reserva hasta que vence el TTL. */
  private readonly duenioSinMigrar = new BanderaConTtl();
  /** La base aun no tiene la reserva con rol (migracion 0047): se usa la de 3 argumentos sin reintentar la nueva en cada llamada. */
  private readonly sinReservaConRol = new BanderaConTtl();

  constructor(private readonly engine: TenancyEngine) {}

  private async reservarUnaVez(organizationId: string, reservationId: string, amountMicroUsd: number, role: string | undefined): Promise<LlmMonthlyReservationTotals | null> {
    const conRol = role !== undefined && !this.sinReservaConRol.activa;
    try {
      return await this.engine.withAppSession({ userId: null }, (session) =>
        new PostgresLlmUsageRepository(session).reserveMonthlyBudget(organizationId, reservationId, amountMicroUsd, conRol ? role : undefined),
      );
    } catch (err) {
      // Base sin migrar: el error 42883 aborta ESA transaccion; el camino anterior corre en una sesion nueva.
      if (conRol && isMigrationPendingError(err)) {
        this.sinReservaConRol.marcar();
        return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).reserveMonthlyBudget(organizationId, reservationId, amountMicroUsd));
      }
      throw err;
    }
  }

  async reserve(organizationId: string, reservationId: string, amountMicroUsd: number, role?: string): Promise<void> {
    try {
      const totals = await this.reservarUnaVez(organizationId, reservationId, amountMicroUsd, role);
      if (totals) {
        const ahora = new Date();
        for (const clave of clavesAvisoUmbral(organizationId, totals, ahora)) await notificarUmbralIaBestEffort(this.engine, this.umbralNotificado, clave, UMBRAL_AVISO_GASTO_IA_PCT);
        // Aviso al dueno de la organizacion (restaurantes) al 80 % de SU tope mensual.
        if (totals.orgCapMicroUsd > 0 && (totals.orgTotalMicroUsd * 100) / totals.orgCapMicroUsd >= UMBRAL_AVISO_GASTO_IA_PCT) {
          await notificarPresupuestoIaDuenioBestEffort(this.engine, this.duenioNotificado, organizationId, 80, ahora, this.duenioSinMigrar);
        }
      }
    } catch (err) {
      if (err instanceof LlmMonthlyBudgetExceededError) {
        // El subtope del Copiloto no agota el presupuesto de la organizacion: no es el aviso de "tope agotado".
        if (err.scope !== "copilot") await notificarTopeIaAgotadoBestEffort(this.engine, this.topeNotificado);
        // Tope de la ORGANIZACION agotado: tambien se avisa a su dueno (el de plataforma no es culpa de una organizacion).
        if (err.scope === "organization") await notificarPresupuestoIaDuenioBestEffort(this.engine, this.duenioNotificado, err.organizationId, 100, undefined, this.duenioSinMigrar);
        throw new MonthlyBudgetExceededError(err.scope, err.organizationId, err.requestedMicroUsd, err.limitMicroUsd);
      }
      // Cualquier otro error (Postgres caído, timeout) se propaga tal cual —
      // fail-closed a propósito, ver el comentario de cabecera de este archivo.
      throw err;
    }
  }

  async settle(_organizationId: string, reservationId: string, actualMicroUsd: number): Promise<void> {
    try {
      await this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).settleMonthlyBudget(reservationId, actualMicroUsd));
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "llm_monthly_budget_settle_failed",
          message: err instanceof Error ? err.message : String(err),
          reservation_id: reservationId,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}

/**
 * Tope DIARIO de turnos LLM por organizacion y rol sobre `core.consume_llm_role_turn` (migracion 0047, conteo atomico entre
 * instancias). Cada llamada abre su PROPIA sesion de sistema. Los roles sin tope por defecto (`defaultRoleDailyTurnLimit`) ni
 * siquiera tocan la base. Un fallo de infraestructura (base sin migrar o caida) es FAIL-OPEN a proposito: el tope diario es una
 * proteccion de uso, y el dinero sigue protegido por el tope mensual (que si es fail-closed).
 */
export class ProductionRoleDailyTurnStore implements RoleDailyTurnStore {
  private readonly noDisponible = new BanderaConTtl();

  constructor(private readonly engine: TenancyEngine) {}

  async consume(organizationId: string, role: string): Promise<void> {
    const defaultLimit = defaultRoleDailyTurnLimit(role);
    if (defaultLimit === undefined || this.noDisponible.activa) return;
    let result;
    try {
      result = await this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).consumeRoleTurn(organizationId, role, defaultLimit));
    } catch (err) {
      if (isMigrationPendingError(err)) this.noDisponible.marcar();
      else console.error(JSON.stringify({ level: "error", event: "llm_role_turn_store_failed", message: err instanceof Error ? err.message.slice(0, 200) : "error", role }));
      return;
    }
    if (!result.allowed) throw new RoleDailyTurnLimitExceededError(role, organizationId, result.used, result.maxTurnos);
  }
}
