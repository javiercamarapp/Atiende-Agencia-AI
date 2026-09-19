// ProductionLlmUsageRepository — adaptador real de `LlmUsageRepository`
// (@atiende/db) para `deps.llmUsageRepo`, consumido por `production/deps.ts`.
//
// MISMO patrón exacto que `ProductionCoreRepository` (`./core-repository.ts`):
// `PostgresLlmUsageRepository` exige un `TenantDbSession` ya abierto en su
// constructor — este wrapper abre una transacción de SISTEMA nueva
// (`engine.withAppSession({userId: null}, ...)`) en CADA llamada, porque las
// funciones SQL que consume son `security definer` con `p_caller_id` explícito
// (nunca dependen de `auth.uid()`) — mismo criterio que
// `isPlatformSuperadmin`/`listProspectosForSuperadmin` de `ProductionCoreRepository`.
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

  getUsageSummaryForSuperadmin(callerId: string, from: string, to: string): Promise<LlmUsageSummaryRow> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).getUsageSummaryForSuperadmin(callerId, from, to));
  }

  listUsageByOrganizationForSuperadmin(callerId: string, from: string, to: string): Promise<readonly LlmUsageByOrganizationRow[]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).listUsageByOrganizationForSuperadmin(callerId, from, to));
  }

  listUsageByProviderModelForSuperadmin(callerId: string, from: string, to: string, organizationId: string | null): Promise<readonly LlmUsageByProviderModelRow[]> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).listUsageByProviderModelForSuperadmin(callerId, from, to, organizationId));
  }

  getPlatformBudgetForSuperadmin(callerId: string): Promise<LlmPlatformBudgetRow> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).getPlatformBudgetForSuperadmin(callerId));
  }

  setOrgMonthlyCapForSuperadmin(callerId: string, organizationId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).setOrgMonthlyCapForSuperadmin(callerId, organizationId, monthlyCapMicroUsd, alertThresholdPct));
  }

  setPlatformMonthlyCapForSuperadmin(callerId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void> {
    return this.engine.withAppSession({ userId: null }, (session) => new PostgresLlmUsageRepository(session).setPlatformMonthlyCapForSuperadmin(callerId, monthlyCapMicroUsd, alertThresholdPct));
  }
}
