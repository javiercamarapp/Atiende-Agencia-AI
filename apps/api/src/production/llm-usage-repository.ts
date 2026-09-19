// ProductionLlmUsageRepository — adaptador real de `LlmUsageRepository`
// (@atiende/db) para `deps.llmUsageRepo`, consumido por `production/deps.ts`.
//
// MISMO patrón exacto que `ProductionCoreRepository` (`./core-repository.ts`):
// `PostgresLlmUsageRepository` exige un `TenantDbSession` ya abierto en su
// constructor — este wrapper abre una transacción NUEVA en CADA llamada
// (nunca reutiliza una conexión entre requests). Dos grupos DISTINTOS de
// funciones, dos tipos DISTINTOS de sesión (hallazgo de seguridad corregido en
// `packages/db/migrations/0011_superadmin_caller_binding.sql`, ver ese archivo
// para el detalle completo):
//   - Las 3 funciones INTERNAS (`recordUsage`/`reserveMonthlyBudget`/
//     `settleMonthlyBudget`, sin `p_caller_id`, solo las invoca este gateway)
//     siguen abriendo sesión de SISTEMA (`{ userId: null }`) — esas EXIGEN
//     `auth.uid() is null` dentro de la función.
//   - Las 6 funciones de BACK OFFICE (`*ForSuperadmin`, con `p_caller_id`
//     explícito) ahora abren sesión COMO el caller autenticado (`{ userId:
//     callerId }`) — esas EXIGEN `auth.uid() = p_caller_id` dentro de la
//     función. Antes de este fix abrían sesión de sistema igual que las
//     internas, lo que dejaba `auth.uid()` siempre NULL y el `p_caller_id`
//     recibido como parámetro plano sin atar a ninguna identidad real.
import type { LlmUsageByOrganizationRow, LlmUsageByProviderModelRow, LlmUsageRepository, LlmPlatformBudgetRow, LlmUsageSummaryRow } from "@atiende/db";
import { PostgresLlmUsageRepository } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";

export class ProductionLlmUsageRepository implements LlmUsageRepository {
  constructor(private readonly engine: TenancyEngine) {}

  recordUsage(...args: Parameters<LlmUsageRepository["recordUsage"]>): ReturnType<LlmUsageRepository["recordUsage"]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).recordUsage(...args));
  }

  reserveMonthlyBudget(...args: Parameters<LlmUsageRepository["reserveMonthlyBudget"]>): ReturnType<LlmUsageRepository["reserveMonthlyBudget"]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).reserveMonthlyBudget(...args));
  }

  settleMonthlyBudget(...args: Parameters<LlmUsageRepository["settleMonthlyBudget"]>): ReturnType<LlmUsageRepository["settleMonthlyBudget"]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).settleMonthlyBudget(...args));
  }

  // Hallazgo de seguridad (ver `packages/db/migrations/0011_superadmin_caller_
  // binding.sql`): las 6 funciones de back office de abajo ahora exigen
  // `auth.uid() = p_caller_id` -- a diferencia de las 3 funciones INTERNAS de
  // arriba (sin `p_caller_id`, sesión de SISTEMA correcta), estas se abren
  // COMO el caller autenticado (`callerId`, ya verificado por `authMiddleware`
  // antes de llegar aquí, ver `apps/api/src/routes/superadmin-llm-usage.ts`),
  // una sola consulta por sesión.
  getUsageSummaryForSuperadmin(callerId: string, from: string, to: string): Promise<LlmUsageSummaryRow> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresLlmUsageRepository(session).getUsageSummaryForSuperadmin(callerId, from, to));
  }

  listUsageByOrganizationForSuperadmin(callerId: string, from: string, to: string): Promise<readonly LlmUsageByOrganizationRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresLlmUsageRepository(session).listUsageByOrganizationForSuperadmin(callerId, from, to));
  }

  listUsageByProviderModelForSuperadmin(callerId: string, from: string, to: string, organizationId: string | null): Promise<readonly LlmUsageByProviderModelRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresLlmUsageRepository(session).listUsageByProviderModelForSuperadmin(callerId, from, to, organizationId));
  }

  getPlatformBudgetForSuperadmin(callerId: string): Promise<LlmPlatformBudgetRow> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresLlmUsageRepository(session).getPlatformBudgetForSuperadmin(callerId));
  }

  setOrgMonthlyCapForSuperadmin(callerId: string, organizationId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresLlmUsageRepository(session).setOrgMonthlyCapForSuperadmin(callerId, organizationId, monthlyCapMicroUsd, alertThresholdPct));
  }

  setPlatformMonthlyCapForSuperadmin(callerId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresLlmUsageRepository(session).setPlatformMonthlyCapForSuperadmin(callerId, monthlyCapMicroUsd, alertThresholdPct));
  }
}
