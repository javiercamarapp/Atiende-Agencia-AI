// ═══════════════════════════════════════════════════════════════════════════
// Presupuesto con RESERVA-ANTES-DE-GASTAR, por tenant y por carril (lane).
//
// PUERTO de Likida/src/lib/llm/budget.ts. Mismo mecanismo de dos fases:
//   1. `reserveBudget` ANTES de llamar al proveedor — si no hay presupuesto,
//      se rechaza y NUNCA se paga la llamada.
//   2. `settleBudget` DESPUÉS, con el costo real — la reserva era una cota
//      superior conservadora, el settle la ajusta (normalmente hacia abajo).
//
// Mismo concepto de CARRILES que `PropositoIa` (interactivo/ocr_lote/fondo)
// en el original: el carril 'interactive' tiene una porción del techo diario
// RESERVADA que ningún carril de fondo puede tocar — "el chofer no se queda
// sin servicio por un lote de fondo" es literal en el comentario del
// original; aquí el equivalente es "un lote de batch/background nunca debe
// dejar sin servicio al huésped/cliente que está esperando una respuesta
// AHORA en el canal interactivo".
//
// DIFERENCIA con el original: Likida reserva/liquida vía una RPC de
// Postgres (`reservar_presupuesto_llm`/`liquidar_presupuesto_llm`) porque ya
// tenía esa infraestructura. La Fase 0 de este monorepo fusionado aún no
// define el store de persistencia del ledger — así que aquí el CONTRATO
// (`BudgetLedgerStore`) es el puerto, con una implementación de referencia en
// memoria (`InMemoryBudgetLedgerStore`) que reproduce la MISMA semántica de
// reserva atómica por tenant (single-threaded en Node, así que no hace falta
// un lock explícito) y los mismos tres topes (run/tenant/carril). Un store
// Postgres real implementaría el mismo contrato contra dos RPCs análogas.
// ═══════════════════════════════════════════════════════════════════════════

import { GatewayBudgetExceededError } from './errors.js';
import type { LlmLane } from './types.js';

/** Qué fracción del techo diario del tenant queda reservada para el carril
 *  'interactive'. Igual que `fraccionReservaInteractivo` en Likida: 0.4 por
 *  defecto. */
export const DEFAULT_INTERACTIVE_RESERVE_FRACTION = 0.4;

export interface GatewayBudgetLimits {
  /** Tope duro por corrida (run). */
  maxRunUsd: number;
  /** Techo diario del tenant, compartido entre los 3 carriles. */
  maxTenantDailyUsd: number;
  /** Fracción de `maxTenantDailyUsd` reservada solo para 'interactive'
   *  (0..1). Por defecto `DEFAULT_INTERACTIVE_RESERVE_FRACTION`. */
  interactiveReserveFraction?: number;
}

export interface GatewayBudget {
  tenantId: string;
  runId: string;
  lane: LlmLane;
  maxRunUsd: number;
  maxTenantDailyUsd: number;
  interactiveReserveUsd: number;
  reservedRunUsd: number;
}

export interface BudgetReservation {
  id: string;
  amountUsd: number;
}

let reservationCounter = 0;
function nextReservationId(): string {
  reservationCounter += 1;
  return `res_${Date.now().toString(36)}_${reservationCounter}`;
}

export function createGatewayBudget(
  tenantId: string,
  runId: string,
  lane: LlmLane,
  limits: GatewayBudgetLimits,
): GatewayBudget {
  if (!tenantId.trim()) throw new Error('gateway_budget: tenantId requerido');
  if (!runId.trim()) throw new Error('gateway_budget: runId requerido');
  const fraction = limits.interactiveReserveFraction ?? DEFAULT_INTERACTIVE_RESERVE_FRACTION;
  return {
    tenantId,
    runId,
    lane,
    maxRunUsd: limits.maxRunUsd,
    maxTenantDailyUsd: limits.maxTenantDailyUsd,
    interactiveReserveUsd: Number((limits.maxTenantDailyUsd * Math.min(1, Math.max(0, fraction))).toFixed(6)),
    reservedRunUsd: 0,
  };
}

/**
 * Contrato de persistencia del ledger de gasto diario por tenant. Cualquier
 * store real (Postgres, Redis, Supabase RPC…) implementa esto; el gateway
 * solo conoce la interfaz.
 */
export interface BudgetLedgerStore {
  /**
   * Reserva `amountUsd` contra el gasto YA COMPROMETIDO del tenant hoy.
   * Devuelve el nuevo total comprometido (incluida esta reserva) partido por
   * carril, para que `reserveBudget` pueda aplicar los tres topes sin que el
   * store conozca la política de negocio.
   */
  reserve(tenantId: string, reservationId: string, lane: LlmLane, amountUsd: number): Promise<TenantDailySpend>;
  /** Ajusta una reserva ya hecha al costo real (puede subir o bajar el comprometido del tenant). */
  settle(tenantId: string, reservationId: string, actualUsd: number): Promise<void>;
}

export interface TenantDailySpend {
  /** Total comprometido HOY por el tenant, sumando todos los carriles (incluida la reserva que se acaba de pedir). */
  totalUsd: number;
  /** Comprometido HOY solo por carriles que NO son 'interactive' (batch + background). */
  nonInteractiveUsd: number;
}

/**
 * Ledger de referencia en memoria. Misma semántica de reserva atómica que la
 * RPC de Postgres del original: en Node, una sola vuelta de microtask entre
 * el `get` y el `set` del Map es indivisible frente a otra invocación
 * `async` mientras no haya un `await` en medio — así que la reserva de abajo
 * SÍ es atómica por proceso. Un despliegue multi-instancia necesita el store
 * Postgres/Redis real; el contrato es el mismo.
 */
export class InMemoryBudgetLedgerStore implements BudgetLedgerStore {
  private readonly reservations = new Map<string, { tenantId: string; lane: LlmLane; amountUsd: number; day: string }>();

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private sumFor(tenantId: string, day: string): TenantDailySpend {
    let totalUsd = 0;
    let nonInteractiveUsd = 0;
    for (const r of this.reservations.values()) {
      if (r.tenantId !== tenantId || r.day !== day) continue;
      totalUsd += r.amountUsd;
      if (r.lane !== 'interactive') nonInteractiveUsd += r.amountUsd;
    }
    return {
      totalUsd: Number(totalUsd.toFixed(6)),
      nonInteractiveUsd: Number(nonInteractiveUsd.toFixed(6)),
    };
  }

  async reserve(tenantId: string, reservationId: string, lane: LlmLane, amountUsd: number): Promise<TenantDailySpend> {
    const day = this.today();
    this.reservations.set(reservationId, { tenantId, lane, amountUsd, day });
    return this.sumFor(tenantId, day);
  }

  async settle(tenantId: string, reservationId: string, actualUsd: number): Promise<void> {
    const existing = this.reservations.get(reservationId);
    if (!existing) return; // liquidar una reserva desconocida es no-op (idempotente)
    existing.amountUsd = actualUsd;
  }

  /** Solo para tests: libera una reserva por completo (equivalente a costo real $0, p.ej. tras un fallo del proveedor donde no se cobró nada). */
  async release(reservationId: string): Promise<void> {
    this.reservations.delete(reservationId);
  }

  /** Solo para tests/dashboard. */
  reset(): void {
    this.reservations.clear();
  }
}

/**
 * Reserva antes de llamar al proveedor. Aplica los TRES topes en orden —
 * corrida, carril (si no es 'interactive'), tenant — y lanza
 * `GatewayBudgetExceededError` con el `scope` que frenó, igual que
 * `reserveLlmBudget` en Likida.
 */
export async function reserveBudget(
  store: BudgetLedgerStore,
  budget: GatewayBudget,
  amountUsd: number,
): Promise<BudgetReservation> {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('gateway_budget: reserva inválida');

  if (budget.reservedRunUsd + amountUsd > budget.maxRunUsd + 1e-9) {
    throw new GatewayBudgetExceededError('run', budget.reservedRunUsd + amountUsd, budget.maxRunUsd);
  }

  const id = nextReservationId();
  const spend = await store.reserve(budget.tenantId, id, budget.lane, amountUsd);

  // Carril de fondo/batch: no puede tocar la porción reservada para
  // 'interactive'. Mismo criterio que `tope_proposito` en la RPC de Likida.
  if (budget.lane !== 'interactive') {
    const nonInteractiveCeiling = Math.max(0, budget.maxTenantDailyUsd - budget.interactiveReserveUsd);
    if (spend.nonInteractiveUsd > nonInteractiveCeiling + 1e-9) {
      await store.settle(budget.tenantId, id, 0); // liberar: nunca se llamó al proveedor
      throw new GatewayBudgetExceededError('lane', amountUsd, nonInteractiveCeiling);
    }
  }

  // Techo diario del tenant, compartido entre todos los carriles.
  if (spend.totalUsd > budget.maxTenantDailyUsd + 1e-9) {
    await store.settle(budget.tenantId, id, 0);
    throw new GatewayBudgetExceededError('tenant', amountUsd, budget.maxTenantDailyUsd);
  }

  budget.reservedRunUsd += amountUsd;
  return { id, amountUsd };
}

/** Ajusta la reserva al costo real reportado por el proveedor. */
export async function settleBudget(
  store: BudgetLedgerStore,
  budget: GatewayBudget,
  reservation: BudgetReservation,
  actualUsd: number,
): Promise<void> {
  const real = Number.isFinite(actualUsd) && actualUsd >= 0 ? actualUsd : reservation.amountUsd;
  budget.reservedRunUsd = Math.max(0, budget.reservedRunUsd - reservation.amountUsd + real);
  await store.settle(budget.tenantId, reservation.id, real);
}
