// ProductionResumenDiarioRepository -- adaptador real de `ResumenDiarioRepository`
// (@atiende/db) para `deps.resumenDiarioRepo`, consumido por
// `production/deps.ts`. MISMO patrón exacto que `ProductionSaludRepository`
// (`./salud-repository.ts`): `PostgresResumenDiarioRepository` exige un
// `TenantDbSession` ya abierto en su constructor -- este wrapper abre una
// transacción NUEVA en CADA llamada.
//
// TODAS las lecturas/escrituras `*ForSystem`/`upsertDailyOpsSummary`/
// `markDailyOpsSummaryEmailSent` abren sesión de SISTEMA (`{ userId: null
// }`) -- las funciones SQL que consumen exigen `auth.uid() is null`. Las 2
// lecturas `*ForSuperadmin` del final abren sesión COMO el caller (`{
// userId: callerId }`) -- las funciones SQL exigen `auth.uid() =
// p_caller_id`.
import type {
  CronHeartbeatSystemRow,
  DailyOpsSummaryRow,
  FacturacionAgregadoRow,
  LicitacionesFuenteRunSystemRow,
  LlmPlatformBudgetSystemRow,
  LlmUsageTopOrganizacionRow,
  LlmUsageTotalRow,
  OrganizacionesStaffNuevosRow,
  OutboxDiarioRow,
  ProspectosAgregadoRow,
  ResumenDiarioRepository,
  UpsertDailyOpsSummaryInput,
  VentanaDia,
} from "@atiende/db";
import { PostgresResumenDiarioRepository } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";

export class ProductionResumenDiarioRepository implements ResumenDiarioRepository {
  constructor(private readonly engine: TenancyEngine) {}

  private sistema<T>(fn: (repo: PostgresResumenDiarioRepository) => Promise<T>): Promise<T> {
    return this.engine.withAppSession({ userId: null }, (session) => fn(new PostgresResumenDiarioRepository(session)));
  }

  listCronHeartbeatsForSystem(): Promise<readonly CronHeartbeatSystemRow[]> {
    return this.sistema((repo) => repo.listCronHeartbeatsForSystem());
  }
  getOutboxHealthForSystem(ventana: VentanaDia): Promise<readonly OutboxDiarioRow[]> {
    return this.sistema((repo) => repo.getOutboxHealthForSystem(ventana));
  }
  listLicitacionesFuenteRunsForSystem(): Promise<readonly LicitacionesFuenteRunSystemRow[]> {
    return this.sistema((repo) => repo.listLicitacionesFuenteRunsForSystem());
  }
  getLlmPlatformBudgetForSystem(): Promise<LlmPlatformBudgetSystemRow | null> {
    return this.sistema((repo) => repo.getLlmPlatformBudgetForSystem());
  }
  getLlmUsageTotalForSystem(fecha: string): Promise<LlmUsageTotalRow> {
    return this.sistema((repo) => repo.getLlmUsageTotalForSystem(fecha));
  }
  listLlmUsageTopOrganizacionesForSystem(fecha: string, limit: number): Promise<readonly LlmUsageTopOrganizacionRow[]> {
    return this.sistema((repo) => repo.listLlmUsageTopOrganizacionesForSystem(fecha, limit));
  }
  getOrganizacionesStaffNuevosForSystem(ventana: VentanaDia): Promise<OrganizacionesStaffNuevosRow> {
    return this.sistema((repo) => repo.getOrganizacionesStaffNuevosForSystem(ventana));
  }
  getProspectosAgregadoForSystem(ventana: VentanaDia, umbralSinMovimiento: string): Promise<ProspectosAgregadoRow> {
    return this.sistema((repo) => repo.getProspectosAgregadoForSystem(ventana, umbralSinMovimiento));
  }
  getFacturacionAgregadoForSystem(ventana: VentanaDia): Promise<FacturacionAgregadoRow> {
    return this.sistema((repo) => repo.getFacturacionAgregadoForSystem(ventana));
  }
  countBreakGlassAbiertosForSystem(ventana: VentanaDia): Promise<number> {
    return this.sistema((repo) => repo.countBreakGlassAbiertosForSystem(ventana));
  }
  listPlatformSuperadminEmailsForSystem(): Promise<readonly string[]> {
    return this.sistema((repo) => repo.listPlatformSuperadminEmailsForSystem());
  }
  getDailyOpsSummaryForSystem(fecha: string): Promise<DailyOpsSummaryRow | null> {
    return this.sistema((repo) => repo.getDailyOpsSummaryForSystem(fecha));
  }
  upsertDailyOpsSummary(input: UpsertDailyOpsSummaryInput): Promise<void> {
    return this.sistema((repo) => repo.upsertDailyOpsSummary(input));
  }
  markDailyOpsSummaryEmailSent(fecha: string): Promise<boolean> {
    return this.sistema((repo) => repo.markDailyOpsSummaryEmailSent(fecha));
  }

  listDailyOpsSummariesForSuperadmin(callerId: string, limit: number): Promise<readonly DailyOpsSummaryRow[]> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresResumenDiarioRepository(session).listDailyOpsSummariesForSuperadmin(callerId, limit));
  }
  getDailyOpsSummaryForSuperadmin(callerId: string, fecha: string): Promise<DailyOpsSummaryRow | null> {
    return this.engine.withAppSession({ userId: callerId }, (session) => new PostgresResumenDiarioRepository(session).getDailyOpsSummaryForSuperadmin(callerId, fecha));
  }
}
