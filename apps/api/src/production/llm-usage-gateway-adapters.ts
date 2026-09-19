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
import { LlmMonthlyBudgetExceededError, PostgresLlmUsageRepository } from "@atiende/db";
import { MonthlyBudgetExceededError, type LlmUsageEvent, type OrgMonthlyBudgetStore, type UsageRecorder } from "@atiende/agent-core";
import type { TenancyEngine } from "@atiende/core-tenancy";

export class ProductionLlmUsageRecorder implements UsageRecorder {
  constructor(private readonly engine: TenancyEngine) {}

  async record(event: LlmUsageEvent): Promise<void> {
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

export class ProductionOrgMonthlyBudgetStore implements OrgMonthlyBudgetStore {
  constructor(private readonly engine: TenancyEngine) {}

  async reserve(organizationId: string, reservationId: string, amountMicroUsd: number): Promise<void> {
    try {
      await this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).reserveMonthlyBudget(organizationId, reservationId, amountMicroUsd));
    } catch (err) {
      if (err instanceof LlmMonthlyBudgetExceededError) {
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
