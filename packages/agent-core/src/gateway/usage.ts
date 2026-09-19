// ═══════════════════════════════════════════════════════════════════════════
// Puerto de REGISTRO DE USO del gateway — auditoría de "esta llamada pasó y
// costó tanto", DISTINTA del presupuesto (`budget.ts`, autoritativo, decide si
// se llama o no) y del cap mensual (`org-monthly-budget.ts`, autoritativo
// también). Este puerto es puramente de OBSERVABILIDAD: alimenta el back
// office de plataforma (control de gasto de API de LLM), nunca decide si una
// llamada procede.
//
// Deliberadamente agnóstico de Postgres (el gateway vive en `agent-core`, sin
// dependencias de infraestructura): cualquier implementación real (Postgres,
// otro almacén) vive fuera de este paquete (ver
// `apps/api/src/production/llm-usage-gateway-adapters.ts`) y se inyecta vía
// `LlmGatewayOptions.usageRecorder`.
//
// CONTRATO best-effort: `LlmGateway.complete()` envuelve cada llamada a
// `record()` en un `try/catch` propio (ver gateway.ts) — un fallo de registro
// (Postgres caído, timeout, lo que sea) NUNCA tumba ni convierte en error una
// llamada al LLM que sí tuvo éxito. Cualquier implementación real debe evitar
// lanzar hacia el gateway, pero aunque lo hiciera, el gateway ya la atrapa.
// ═══════════════════════════════════════════════════════════════════════════

import type { LlmLane } from './types.js';

/** Un evento de uso real de una llamada al LLM que SÍ tuvo éxito (nunca se
 *  registra un intento fallido: no hubo tokens/costo real que auditar, mismo
 *  criterio que `settleBudget(..., 0)` en el catch de `gateway.ts`). */
export interface LlmUsageEvent {
  /** Organización dueña de la llamada — mismo valor que `GatewayCallOptions.tenantId`. */
  readonly organizationId: string;
  /** Vertical de negocio (`hoteles`/`restaurantes`/`rentas`/`licitaciones`/`citas`/`despachos`),
   *  derivada del prefijo de `role` antes de los ':' — ver `deriveVerticalFromRole`. */
  readonly vertical: string;
  /** Rol lógico completo tal como se registró en `registerLadder` (p.ej.
   *  `"hoteles:whatsapp_agent"`), para desglose más fino que solo `vertical`. */
  readonly role: string;
  readonly lane: LlmLane;
  readonly providerId: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** Costo real reportado por el proveedor, en MICRO-USD (1 USD = 1_000_000),
   *  entero SIEMPRE — nunca un float de dólares (ver `usdToMicroUsd`). */
  readonly costMicroUsd: number;
  /** true si el proveedor que respondió no era el primero de la escalera —
   *  mismo campo que `GatewayCallResult.fallbackUsed`, útil para desglose de
   *  confiabilidad por proveedor en el back office. */
  readonly fallbackUsed: boolean;
  /** ISO 8601 — momento en que el gateway obtuvo la respuesta (no necesariamente
   *  el que usa el store real: un store Postgres puede preferir `now()` del
   *  servidor de base de datos para evitar sesgo de reloj del proceso). */
  readonly occurredAt: string;
}

export interface UsageRecorder {
  record(event: LlmUsageEvent): Promise<void>;
}

/** Implementación por defecto cuando `LlmGatewayOptions.usageRecorder` no se
 *  pasa — mismo espíritu que un `BudgetLedgerStore` en memoria: el gateway
 *  sigue funcionando exactamente igual (ninguna vertical se rompe) sin que
 *  exista todavía observabilidad de gasto detrás. */
export const NoopUsageRecorder: UsageRecorder = {
  async record(): Promise<void> {
    // intencional: sin store configurado, no hay nada que registrar.
  },
};

/** `"hoteles:whatsapp_agent"` -> `"hoteles"`. Un rol sin ':' se devuelve tal
 *  cual (defensivo — hoy todos los roles de producción lo llevan, ver
 *  `apps/api/src/production/llm-gateway.ts::ALL_PRODUCTION_ROLES`). */
export function deriveVerticalFromRole(role: string): string {
  const idx = role.indexOf(':');
  return idx === -1 ? role : role.slice(0, idx);
}

/** USD (float, lo que devuelve cada `LlmProvider.complete()`) -> micro-USD
 *  (entero). Redondea al micro-USD más cercano; nunca negativo, nunca NaN. */
export function usdToMicroUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 1_000_000);
}
