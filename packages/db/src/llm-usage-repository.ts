// LlmUsageRepository — puerto de "control de gasto de API de LLM" del back
// office de plataforma (`GET/PUT /superadmin/gasto-api/*`, ver
// `apps/api/src/routes/superadmin-llm-usage.ts`) MÁS el puerto Postgres que
// alimenta al gateway (`packages/agent-core/src/gateway::UsageRecorder`/
// `OrgMonthlyBudgetStore`, ver `apps/api/src/production/
// llm-usage-gateway-adapters.ts` para el adaptador que los conecta).
//
// Puerto APARTE de `CoreRepository` a propósito (mismo criterio que
// `rentasOwnerPortalRepo`/`rentasCalendarSyncRepo`, ver el comentario de
// cabecera de `apps/api/src/deps.ts`): tablas nuevas
// (`core.llm_usage_daily`/`core.llm_org_budget`/`core.llm_platform_budget`/
// `core.llm_monthly_reservation`, ver
// `migrations/0010_llm_usage_budget_schema.sql`), sin depender del
// repositorio gigante de auth/organizaciones/prospectos para leerse/probarse.
//
// Objeto FIJO (no una fábrica por-request), mismo patrón que `CoreRepository`:
// las funciones SQL son `security definer` con `p_caller_id`/sin caller
// explícito (nunca dependen de `auth.uid()`), así que corren siempre sobre la
// sesión de SISTEMA (ver `apps/api/src/production/llm-usage-repository.ts`).
import type { TenantDbSession } from "@atiende/core-tenancy";

export interface LlmUsageEventInput {
  readonly organizationId: string;
  readonly vertical: string;
  readonly role: string;
  readonly providerId: string;
  readonly model: string;
  readonly lane: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: number;
  readonly fallbackUsed: boolean;
}

export interface LlmUsageSummaryRow {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: number;
  readonly callCount: number;
  readonly fallbackCallCount: number;
}

export interface LlmUsageByOrganizationRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly vertical: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: number;
  readonly callCount: number;
  readonly monthlyCapMicroUsd: number;
  readonly alertThresholdPct: number;
  readonly spendThisMonthMicroUsd: number;
}

export interface LlmUsageByProviderModelRow {
  readonly vertical: string;
  readonly providerId: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: number;
  readonly callCount: number;
}

export interface LlmPlatformBudgetRow {
  readonly monthlyCapMicroUsd: number;
  readonly alertThresholdPct: number;
  readonly spendThisMonthMicroUsd: number;
}

/** Puerto de `MonthlyBudgetExceededError` (`@atiende/agent-core`) — el
 *  adaptador de producción (`llm-usage-gateway-adapters.ts`) traduce ESTE
 *  error al de agent-core, para que agent-core no dependa de `@atiende/db`
 *  (ver el comentario de cabecera de `org-monthly-budget.ts`: el puerto vive
 *  en agent-core, sin acoplarlo a Postgres). */
export class LlmMonthlyBudgetExceededError extends Error {
  constructor(
    readonly scope: "organization" | "platform",
    readonly organizationId: string,
    readonly requestedMicroUsd: number,
    readonly limitMicroUsd: number,
  ) {
    super(`llm_monthly_budget_exceeded:${scope}:${organizationId}:${requestedMicroUsd}:${limitMicroUsd}`);
    this.name = "LlmMonthlyBudgetExceededError";
  }
}

export class LlmOrganizationNotFoundError extends Error {
  constructor(organizationId: string) {
    super(`La organización "${organizationId}" no existe.`);
    this.name = "LlmOrganizationNotFoundError";
  }
}

export interface LlmUsageRepository {
  // ---- consumidas por el gateway (best-effort/autoritativo, ver
  // apps/api/src/production/llm-usage-gateway-adapters.ts) ----
  recordUsage(event: LlmUsageEventInput): Promise<void>;
  /** Lanza `LlmMonthlyBudgetExceededError` si cualquiera de los dos topes
   *  (organización/plataforma) se excede — nunca deja una reserva a medias. */
  reserveMonthlyBudget(organizationId: string, reservationId: string, amountMicroUsd: number): Promise<void>;
  settleMonthlyBudget(reservationId: string, actualMicroUsd: number): Promise<void>;

  // ---- back office de plataforma (control de gasto de API de LLM) ----
  getUsageSummaryForSuperadmin(callerId: string, from: string, to: string): Promise<LlmUsageSummaryRow>;
  listUsageByOrganizationForSuperadmin(callerId: string, from: string, to: string): Promise<readonly LlmUsageByOrganizationRow[]>;
  listUsageByProviderModelForSuperadmin(callerId: string, from: string, to: string, organizationId: string | null): Promise<readonly LlmUsageByProviderModelRow[]>;
  getPlatformBudgetForSuperadmin(callerId: string): Promise<LlmPlatformBudgetRow>;
  setOrgMonthlyCapForSuperadmin(callerId: string, organizationId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void>;
  setPlatformMonthlyCapForSuperadmin(callerId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void>;
}

/** Default aplicado tanto por Postgres (`core.default_llm_org_monthly_cap_micro_usd()`)
 *  como por el store en memoria — MISMO valor, documentado una sola vez aquí
 *  para que no diverjan (ver el comentario de esa función SQL). */
export const DEFAULT_LLM_ORG_MONTHLY_CAP_MICRO_USD = 100_000_000; // $100 USD/mes
export const DEFAULT_LLM_ALERT_THRESHOLD_PCT = 80;

// ═══════════════════════════════════════════════════════════════════════════
// PostgresLlmUsageRepository — adaptador real, constructor(db: TenantDbSession)
// mismo patrón que `PostgresCoreRepository`.
// ═══════════════════════════════════════════════════════════════════════════

interface UsageSummaryRawRow {
  tokens_in: string;
  tokens_out: string;
  cost_micro_usd: string;
  call_count: string;
  fallback_call_count: string;
}

interface UsageByOrganizationRawRow {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  vertical: string;
  tokens_in: string;
  tokens_out: string;
  cost_micro_usd: string;
  call_count: string;
  monthly_cap_micro_usd: string;
  alert_threshold_pct: string;
  spend_this_month_micro_usd: string;
}

interface UsageByProviderModelRawRow {
  vertical: string;
  provider_id: string;
  model: string;
  tokens_in: string;
  tokens_out: string;
  cost_micro_usd: string;
  call_count: string;
}

interface PlatformBudgetRawRow {
  monthly_cap_micro_usd: string;
  alert_threshold_pct: string;
  spend_this_month_micro_usd: string;
}

function n(v: string | number | null | undefined): number {
  return v === null || v === undefined ? 0 : Number(v);
}

/** `err.message` de Postgres para `reserve_llm_monthly_budget` viene como
 *  `"llm_monthly_budget_exceeded:<scope>:<orgId>:<requested>:<limit>"` (ver la
 *  migración) — lo parseamos en vez de depender de un shape de error propio
 *  del driver `pg`, mismo criterio defensivo que el resto de este paquete
 *  frente a errores de Postgres (ver `markNotificationRead`::code === "P0002"). */
function parseMonthlyBudgetExceeded(err: unknown): LlmMonthlyBudgetExceededError | null {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const match = /llm_monthly_budget_exceeded:(organization|platform):([^:]+):(\d+):(\d+)/.exec(message);
  if (!match) return null;
  const [, scope, organizationId, requested, limit] = match as unknown as [string, "organization" | "platform", string, string, string];
  return new LlmMonthlyBudgetExceededError(scope, organizationId, Number(requested), Number(limit));
}

export class PostgresLlmUsageRepository implements LlmUsageRepository {
  constructor(private readonly db: TenantDbSession) {}

  async recordUsage(event: LlmUsageEventInput): Promise<void> {
    await this.db.query(
      `select core.record_llm_usage($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);`,
      [
        event.organizationId,
        event.vertical,
        event.role,
        event.providerId,
        event.model,
        event.lane,
        Math.trunc(event.tokensIn),
        Math.trunc(event.tokensOut),
        Math.trunc(event.costMicroUsd),
        event.fallbackUsed,
      ],
    );
  }

  async reserveMonthlyBudget(organizationId: string, reservationId: string, amountMicroUsd: number): Promise<void> {
    try {
      await this.db.query(`select core.reserve_llm_monthly_budget($1, $2, $3);`, [organizationId, reservationId, Math.trunc(amountMicroUsd)]);
    } catch (err) {
      const parsed = parseMonthlyBudgetExceeded(err);
      if (parsed) throw parsed;
      throw err;
    }
  }

  async settleMonthlyBudget(reservationId: string, actualMicroUsd: number): Promise<void> {
    await this.db.query(`select core.settle_llm_monthly_budget($1, $2);`, [reservationId, Math.trunc(Math.max(0, actualMicroUsd))]);
  }

  async getUsageSummaryForSuperadmin(callerId: string, from: string, to: string): Promise<LlmUsageSummaryRow> {
    const { rows } = await this.db.query<UsageSummaryRawRow>(
      `select tokens_in, tokens_out, cost_micro_usd, call_count, fallback_call_count
       from core.get_llm_usage_summary_for_superadmin($1, $2, $3);`,
      [callerId, from, to],
    );
    const r = rows[0];
    return {
      tokensIn: n(r?.tokens_in),
      tokensOut: n(r?.tokens_out),
      costMicroUsd: n(r?.cost_micro_usd),
      callCount: n(r?.call_count),
      fallbackCallCount: n(r?.fallback_call_count),
    };
  }

  async listUsageByOrganizationForSuperadmin(callerId: string, from: string, to: string): Promise<readonly LlmUsageByOrganizationRow[]> {
    const { rows } = await this.db.query<UsageByOrganizationRawRow>(
      `select organization_id, organization_name, organization_slug, vertical, tokens_in, tokens_out, cost_micro_usd, call_count,
              monthly_cap_micro_usd, alert_threshold_pct, spend_this_month_micro_usd
       from core.list_llm_usage_by_organization_for_superadmin($1, $2, $3);`,
      [callerId, from, to],
    );
    return rows.map((r) => ({
      organizationId: r.organization_id,
      organizationName: r.organization_name,
      organizationSlug: r.organization_slug,
      vertical: r.vertical,
      tokensIn: n(r.tokens_in),
      tokensOut: n(r.tokens_out),
      costMicroUsd: n(r.cost_micro_usd),
      callCount: n(r.call_count),
      monthlyCapMicroUsd: n(r.monthly_cap_micro_usd),
      alertThresholdPct: n(r.alert_threshold_pct),
      spendThisMonthMicroUsd: n(r.spend_this_month_micro_usd),
    }));
  }

  async listUsageByProviderModelForSuperadmin(callerId: string, from: string, to: string, organizationId: string | null): Promise<readonly LlmUsageByProviderModelRow[]> {
    const { rows } = await this.db.query<UsageByProviderModelRawRow>(
      `select vertical, provider_id, model, tokens_in, tokens_out, cost_micro_usd, call_count
       from core.list_llm_usage_by_provider_model_for_superadmin($1, $2, $3, $4);`,
      [callerId, from, to, organizationId],
    );
    return rows.map((r) => ({
      vertical: r.vertical,
      providerId: r.provider_id,
      model: r.model,
      tokensIn: n(r.tokens_in),
      tokensOut: n(r.tokens_out),
      costMicroUsd: n(r.cost_micro_usd),
      callCount: n(r.call_count),
    }));
  }

  async getPlatformBudgetForSuperadmin(callerId: string): Promise<LlmPlatformBudgetRow> {
    const { rows } = await this.db.query<PlatformBudgetRawRow>(`select monthly_cap_micro_usd, alert_threshold_pct, spend_this_month_micro_usd from core.get_llm_platform_budget_for_superadmin($1);`, [callerId]);
    const r = rows[0];
    return {
      monthlyCapMicroUsd: n(r?.monthly_cap_micro_usd),
      alertThresholdPct: n(r?.alert_threshold_pct),
      spendThisMonthMicroUsd: n(r?.spend_this_month_micro_usd),
    };
  }

  async setOrgMonthlyCapForSuperadmin(callerId: string, organizationId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void> {
    try {
      await this.db.query(`select core.set_llm_org_monthly_cap_for_superadmin($1, $2, $3, $4);`, [callerId, organizationId, Math.trunc(monthlyCapMicroUsd), alertThresholdPct]);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "P0002") throw new LlmOrganizationNotFoundError(organizationId);
      throw err;
    }
  }

  async setPlatformMonthlyCapForSuperadmin(callerId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void> {
    await this.db.query(`select core.set_llm_platform_monthly_cap_for_superadmin($1, $2, $3);`, [callerId, Math.trunc(monthlyCapMicroUsd), alertThresholdPct]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// InMemoryLlmUsageRepository — referencia real (no un mock) para tests, misma
// semántica que el store Postgres (incluida la reserva-antes-de-gastar
// mensual con los dos topes). Organizaciones propias (`seedOrganization`,
// mismo patrón que `InMemoryCoreRepository::SeedOrganization`) para no acoplar
// este puerto al repo gigante de auth — los tests que ejercitan ambos siembran
// el MISMO id/nombre/slug/vertical en los dos.
// ═══════════════════════════════════════════════════════════════════════════

export interface InMemoryLlmUsageOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly vertical: string;
}

interface UsageDailyKeyed {
  organizationId: string;
  usageDate: string; // YYYY-MM-DD
  vertical: string;
  role: string;
  providerId: string;
  model: string;
  lane: string;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  callCount: number;
  fallbackCallCount: number;
}

export class InMemoryLlmUsageRepository implements LlmUsageRepository {
  private readonly organizations = new Map<string, InMemoryLlmUsageOrganization>();
  private readonly usageByKey = new Map<string, UsageDailyKeyed>();
  private readonly orgBudgets = new Map<string, { monthlyCapMicroUsd: number; alertThresholdPct: number }>();
  private platformBudget = { monthlyCapMicroUsd: 1_000_000_000, alertThresholdPct: DEFAULT_LLM_ALERT_THRESHOLD_PCT };
  private readonly monthlyReservations = new Map<string, { organizationId: string; month: string; amountMicroUsd: number }>();
  private readonly isSuperadmin = new Set<string>();

  seedOrganization(org: InMemoryLlmUsageOrganization): void {
    this.organizations.set(org.id, org);
  }

  addPlatformSuperadmin(staffId: string): void {
    this.isSuperadmin.add(staffId);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private month(): string {
    return new Date().toISOString().slice(0, 7);
  }

  private orgCapFor(organizationId: string): number {
    return this.orgBudgets.get(organizationId)?.monthlyCapMicroUsd ?? DEFAULT_LLM_ORG_MONTHLY_CAP_MICRO_USD;
  }

  async recordUsage(event: LlmUsageEventInput): Promise<void> {
    const key = [event.organizationId, this.today(), event.vertical, event.role, event.providerId, event.model, event.lane].join("|");
    const existing = this.usageByKey.get(key);
    if (existing) {
      existing.tokensIn += Math.max(0, event.tokensIn);
      existing.tokensOut += Math.max(0, event.tokensOut);
      existing.costMicroUsd += Math.max(0, event.costMicroUsd);
      existing.callCount += 1;
      existing.fallbackCallCount += event.fallbackUsed ? 1 : 0;
    } else {
      this.usageByKey.set(key, {
        organizationId: event.organizationId,
        usageDate: this.today(),
        vertical: event.vertical,
        role: event.role,
        providerId: event.providerId,
        model: event.model,
        lane: event.lane,
        tokensIn: Math.max(0, event.tokensIn),
        tokensOut: Math.max(0, event.tokensOut),
        costMicroUsd: Math.max(0, event.costMicroUsd),
        callCount: 1,
        fallbackCallCount: event.fallbackUsed ? 1 : 0,
      });
    }
  }

  async reserveMonthlyBudget(organizationId: string, reservationId: string, amountMicroUsd: number): Promise<void> {
    const month = this.month();
    const orgCap = this.orgCapFor(organizationId);
    let orgTotal = 0;
    let platformTotal = 0;
    for (const r of this.monthlyReservations.values()) {
      if (r.month !== month) continue;
      platformTotal += r.amountMicroUsd;
      if (r.organizationId === organizationId) orgTotal += r.amountMicroUsd;
    }
    if (orgTotal + amountMicroUsd > orgCap) {
      throw new LlmMonthlyBudgetExceededError("organization", organizationId, orgTotal + amountMicroUsd, orgCap);
    }
    if (platformTotal + amountMicroUsd > this.platformBudget.monthlyCapMicroUsd) {
      throw new LlmMonthlyBudgetExceededError("platform", organizationId, platformTotal + amountMicroUsd, this.platformBudget.monthlyCapMicroUsd);
    }
    this.monthlyReservations.set(reservationId, { organizationId, month, amountMicroUsd });
  }

  async settleMonthlyBudget(reservationId: string, actualMicroUsd: number): Promise<void> {
    const existing = this.monthlyReservations.get(reservationId);
    if (!existing) return;
    existing.amountMicroUsd = Math.max(0, actualMicroUsd);
  }

  private usageInRange(from: string, to: string): UsageDailyKeyed[] {
    return [...this.usageByKey.values()].filter((u) => u.usageDate >= from && u.usageDate <= to);
  }

  async getUsageSummaryForSuperadmin(callerId: string, from: string, to: string): Promise<LlmUsageSummaryRow> {
    if (!this.isSuperadmin.has(callerId)) return { tokensIn: 0, tokensOut: 0, costMicroUsd: 0, callCount: 0, fallbackCallCount: 0 };
    const rows = this.usageInRange(from, to);
    return rows.reduce(
      (acc, r) => ({
        tokensIn: acc.tokensIn + r.tokensIn,
        tokensOut: acc.tokensOut + r.tokensOut,
        costMicroUsd: acc.costMicroUsd + r.costMicroUsd,
        callCount: acc.callCount + r.callCount,
        fallbackCallCount: acc.fallbackCallCount + r.fallbackCallCount,
      }),
      { tokensIn: 0, tokensOut: 0, costMicroUsd: 0, callCount: 0, fallbackCallCount: 0 },
    );
  }

  async listUsageByOrganizationForSuperadmin(callerId: string, from: string, to: string): Promise<readonly LlmUsageByOrganizationRow[]> {
    if (!this.isSuperadmin.has(callerId)) return [];
    const inRange = this.usageInRange(from, to);
    const thisMonth = this.month();
    const rows: LlmUsageByOrganizationRow[] = [];
    for (const org of this.organizations.values()) {
      const orgRows = inRange.filter((r) => r.organizationId === org.id);
      const spendThisMonth = [...this.usageByKey.values()]
        .filter((r) => r.organizationId === org.id && r.usageDate.slice(0, 7) === thisMonth)
        .reduce((sum, r) => sum + r.costMicroUsd, 0);
      const budget = this.orgBudgets.get(org.id);
      rows.push({
        organizationId: org.id,
        organizationName: org.name,
        organizationSlug: org.slug,
        vertical: org.vertical,
        tokensIn: orgRows.reduce((s, r) => s + r.tokensIn, 0),
        tokensOut: orgRows.reduce((s, r) => s + r.tokensOut, 0),
        costMicroUsd: orgRows.reduce((s, r) => s + r.costMicroUsd, 0),
        callCount: orgRows.reduce((s, r) => s + r.callCount, 0),
        monthlyCapMicroUsd: budget?.monthlyCapMicroUsd ?? DEFAULT_LLM_ORG_MONTHLY_CAP_MICRO_USD,
        alertThresholdPct: budget?.alertThresholdPct ?? DEFAULT_LLM_ALERT_THRESHOLD_PCT,
        spendThisMonthMicroUsd: spendThisMonth,
      });
    }
    return rows.sort((a, b) => b.costMicroUsd - a.costMicroUsd);
  }

  async listUsageByProviderModelForSuperadmin(callerId: string, from: string, to: string, organizationId: string | null): Promise<readonly LlmUsageByProviderModelRow[]> {
    if (!this.isSuperadmin.has(callerId)) return [];
    const inRange = this.usageInRange(from, to).filter((r) => !organizationId || r.organizationId === organizationId);
    const byKey = new Map<string, LlmUsageByProviderModelRow & { tokensIn: number; tokensOut: number; costMicroUsd: number; callCount: number }>();
    for (const r of inRange) {
      const key = [r.vertical, r.providerId, r.model].join("|");
      const existing = byKey.get(key);
      if (existing) {
        existing.tokensIn += r.tokensIn;
        existing.tokensOut += r.tokensOut;
        existing.costMicroUsd += r.costMicroUsd;
        existing.callCount += r.callCount;
      } else {
        byKey.set(key, { vertical: r.vertical, providerId: r.providerId, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costMicroUsd: r.costMicroUsd, callCount: r.callCount });
      }
    }
    return [...byKey.values()].sort((a, b) => b.costMicroUsd - a.costMicroUsd);
  }

  async getPlatformBudgetForSuperadmin(callerId: string): Promise<LlmPlatformBudgetRow> {
    if (!this.isSuperadmin.has(callerId)) return { monthlyCapMicroUsd: 0, alertThresholdPct: 0, spendThisMonthMicroUsd: 0 };
    const thisMonth = this.month();
    const spendThisMonth = [...this.usageByKey.values()].filter((r) => r.usageDate.slice(0, 7) === thisMonth).reduce((s, r) => s + r.costMicroUsd, 0);
    return { monthlyCapMicroUsd: this.platformBudget.monthlyCapMicroUsd, alertThresholdPct: this.platformBudget.alertThresholdPct, spendThisMonthMicroUsd: spendThisMonth };
  }

  async setOrgMonthlyCapForSuperadmin(callerId: string, organizationId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void> {
    if (!this.isSuperadmin.has(callerId)) throw new Error("forbidden");
    if (!this.organizations.has(organizationId)) throw new LlmOrganizationNotFoundError(organizationId);
    this.orgBudgets.set(organizationId, { monthlyCapMicroUsd, alertThresholdPct });
  }

  async setPlatformMonthlyCapForSuperadmin(callerId: string, monthlyCapMicroUsd: number, alertThresholdPct: number): Promise<void> {
    if (!this.isSuperadmin.has(callerId)) throw new Error("forbidden");
    this.platformBudget = { monthlyCapMicroUsd, alertThresholdPct };
  }
}
