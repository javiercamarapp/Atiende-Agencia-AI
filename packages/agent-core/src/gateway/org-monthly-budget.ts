// ═══════════════════════════════════════════════════════════════════════════
// Tope MENSUAL por organización + tope GLOBAL de plataforma, con la MISMA
// semántica de reserva-antes-de-gastar que `budget.ts` (reserve ANTES de
// llamar al proveedor, settle DESPUÉS con el costo real) — pero a diferencia
// de `budget.ts` (en memoria de proceso, "defensa en profundidad" por
// instancia), este puerto está pensado para persistir entre instancias desde
// el día uno: la app corre en Vercel Fluid Compute, así que un contador en
// memoria de proceso NO sirve como fuente de verdad del tope real que el
// back office de plataforma expone y edita.
//
// Igual que `BudgetLedgerStore`, este archivo define el CONTRATO (puerto) más
// una implementación de referencia en memoria (`InMemoryOrgMonthlyBudgetStore`)
// que reproduce la misma semántica para tests — un store Postgres real
// (`apps/api/src/production/llm-usage-gateway-adapters.ts`) implementa el
// mismo contrato contra una función `security definer` que hace el chequeo +
// insert atómicos dentro de una sola transacción.
// ═══════════════════════════════════════════════════════════════════════════

import { MonthlyBudgetExceededError } from './errors.js';

/** Porcentaje del tope mensual de una organización reservado como TECHO del Copiloto. Debe coincidir con
 *  `core.copiloto_subtope_pct()` (migración 0046). */
export const COPILOTO_SUBTOPE_PCT = 30;

/** true si `role` es del Copiloto ("Chatea con tus datos"): `<vertical>:data_chat` o su reintento `<vertical>:data_chat_retry`. */
export function isCopilotoRole(role: string | undefined): boolean {
  return role !== undefined && /:data_chat(_retry)?$/.test(role);
}

export interface OrgMonthlyBudgetStore {
  /** Reserva `amountMicroUsd` contra el mes en curso de `organizationId` (y,
   *  a la vez, contra el total de TODA la plataforma en ese mismo mes).
   *  Lanza `MonthlyBudgetExceededError` — con el `scope` que frenó — si
   *  cualquiera de los dos topes se excede; en ese caso NO debe quedar nada
   *  reservado (la implementación es responsable de no dejar un residuo).
   *  `role` (opcional) permite el SUBTOPE del Copiloto: las reservas de los
   *  roles `*:data_chat` y `*:data_chat_retry` no pasan del
   *  `COPILOTO_SUBTOPE_PCT` % del tope de la organización (`scope: 'copilot'`). */
  reserve(organizationId: string, reservationId: string, amountMicroUsd: number, role?: string): Promise<void>;
  /** Ajusta una reserva ya hecha al costo real (puede subir o bajar el
   *  comprometido del mes). No-op si `reservationId` no existe (idempotente,
   *  mismo criterio que `BudgetLedgerStore.settle`). */
  settle(organizationId: string, reservationId: string, actualMicroUsd: number): Promise<void>;
}

let reservationCounter = 0;
function nextReservationId(): string {
  reservationCounter += 1;
  return `mres_${Date.now().toString(36)}_${reservationCounter}`;
}

/** Genera un id de reserva único para este store — expuesto para que
 *  `gateway.ts` no tenga que conocer el formato interno. */
export function nextOrgMonthlyReservationId(): string {
  return nextReservationId();
}

export interface InMemoryOrgMonthlyBudgetLimits {
  /** Tope por defecto para una organización SIN fila propia configurada —
   *  mismo rol que `coalesce(monthly_cap_micro_usd, <default>)` en el store
   *  Postgres real. */
  defaultOrgCapMicroUsd: number;
  /** Tope global de plataforma, compartido por TODAS las organizaciones. */
  platformCapMicroUsd: number;
  /** Topes específicos por organización, si difieren del default — mismo rol
   *  que una fila real en `core.llm_org_budget`. */
  orgCapsMicroUsd?: Record<string, number>;
}

/**
 * Referencia en memoria — usada en tests para probar el comportamiento de
 * bloqueo (incluido "compartido entre dos instancias del gateway sobre el
 * MISMO store", pasando la misma instancia de este store a dos
 * `new LlmGateway({...})` distintos) sin depender de Postgres real.
 */
export class InMemoryOrgMonthlyBudgetStore implements OrgMonthlyBudgetStore {
  private readonly reservations = new Map<string, { organizationId: string; month: string; amountMicroUsd: number; role?: string }>();

  constructor(private readonly limits: InMemoryOrgMonthlyBudgetLimits) {}

  private currentMonth(): string {
    return new Date().toISOString().slice(0, 7); // "YYYY-MM"
  }

  private orgCapFor(organizationId: string): number {
    return this.limits.orgCapsMicroUsd?.[organizationId] ?? this.limits.defaultOrgCapMicroUsd;
  }

  private sums(month: string, organizationId: string): { orgTotal: number; platformTotal: number } {
    let orgTotal = 0;
    let platformTotal = 0;
    for (const r of this.reservations.values()) {
      if (r.month !== month) continue;
      platformTotal += r.amountMicroUsd;
      if (r.organizationId === organizationId) orgTotal += r.amountMicroUsd;
    }
    return { orgTotal, platformTotal };
  }

  async reserve(organizationId: string, reservationId: string, amountMicroUsd: number, role?: string): Promise<void> {
    if (!Number.isFinite(amountMicroUsd) || amountMicroUsd <= 0) {
      throw new Error('org_monthly_budget: reserva inválida');
    }
    const month = this.currentMonth();
    const { orgTotal, platformTotal } = this.sums(month, organizationId);
    const orgCap = this.orgCapFor(organizationId);

    if (orgTotal + amountMicroUsd > orgCap) {
      throw new MonthlyBudgetExceededError('organization', organizationId, orgTotal + amountMicroUsd, orgCap);
    }
    if (platformTotal + amountMicroUsd > this.limits.platformCapMicroUsd) {
      throw new MonthlyBudgetExceededError('platform', organizationId, platformTotal + amountMicroUsd, this.limits.platformCapMicroUsd);
    }

    if (isCopilotoRole(role)) {
      let copilotoTotal = 0;
      for (const r of this.reservations.values()) {
        if (r.month === month && r.organizationId === organizationId && isCopilotoRole(r.role)) copilotoTotal += r.amountMicroUsd;
      }
      const copilotoCap = Math.floor((orgCap * COPILOTO_SUBTOPE_PCT) / 100);
      if (copilotoTotal + amountMicroUsd > copilotoCap) {
        throw new MonthlyBudgetExceededError('copilot', organizationId, copilotoTotal + amountMicroUsd, copilotoCap);
      }
    }

    this.reservations.set(reservationId, { organizationId, month, amountMicroUsd, ...(role !== undefined ? { role } : {}) });
  }

  async settle(_organizationId: string, reservationId: string, actualMicroUsd: number): Promise<void> {
    const existing = this.reservations.get(reservationId);
    if (!existing) return;
    existing.amountMicroUsd = Math.max(0, Number.isFinite(actualMicroUsd) ? actualMicroUsd : existing.amountMicroUsd);
  }

  /** Solo para tests. */
  reset(): void {
    this.reservations.clear();
  }
}
