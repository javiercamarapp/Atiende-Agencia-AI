// Rn-36 -- adaptador Postgres del checklist de onboarding. Cada medicion corre bajo SAVEPOINT (runWithSavepointFallback): la
// sesion del request es UNA transaccion y un 42P01/42703/42883 sin savepoint la dejaria abortada (25P02) y arrastraria al resto
// de los puntos. 42501 (el rol no lee la tabla) tambien degrada a "no disponible". Un error de otra clase se repropaga.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { DatosOnboardingRentasSinStaff, RentasOnboardingChecklistRepository } from "./repository.ts";

function esDegradable(err: unknown): boolean {
  return isMigrationPendingError(err) || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42501");
}

export class PostgresRentasOnboardingChecklistRepository implements RentasOnboardingChecklistRepository {
  constructor(private readonly db: TenantDbSession) {}

  private medir<T>(primary: () => Promise<T>): Promise<T | null> {
    return runWithSavepointFallback<T | null>({ session: this.db, primary, isRecoverable: esDegradable, fallback: async () => null });
  }

  private async contar(sql: string, organizationId: string): Promise<number | null> {
    return this.medir(async () => {
      const r = await this.db.query<{ n: string }>(sql, [organizationId]);
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  async cargar(organizationId: string): Promise<DatosOnboardingRentasSinStaff> {
    const unidades = await this.contar(`select count(*)::text as n from rentas.unidad where organization_id = $1;`, organizationId);
    const feeds = await this.medir(async () => {
      const r = await this.db.query<{ activos: string; sincronizados: string }>(
        `select count(*) filter (where activo)::text as activos,
                count(*) filter (where activo and ultima_sincronizacion_exitosa_en is not null)::text as sincronizados
         from rentas.canal_feed_externo where organization_id = $1;`,
        [organizationId],
      );
      return { activos: Number(r.rows[0]?.activos ?? 0), sincronizados: Number(r.rows[0]?.sincronizados ?? 0) };
    });
    const unidadesConTarifaBase = await this.contar(`select count(distinct unidad_id)::text as n from rentas.tarifa_base where organization_id = $1;`, organizationId);
    // Una organizacion nueva nace con reglas SUGERIDAS (fuente `default_sugerido...`, migracion 027): no cuentan hasta que alguien
    // las confirma o edita (su fuente deja de empezar asi), igual que la pantalla de reglas las marca como "sugerida".
    const reglasComision = await this.contar(`select count(*)::text as n from rentas.regla_comision_canal where organization_id = $1 and fuente not like 'default\\_sugerido%';`, organizationId);
    const propiedadesConAccesoActivo = await this.contar(`select count(*)::text as n from rentas.acceso_politica where organization_id = $1 and activo;`, organizationId);
    const propietarios = await this.contar(`select count(*)::text as n from rentas.owner_organization where organization_id = $1;`, organizationId);
    const plantillasAprobadas = await this.contar(`select count(*)::text as n from rentas.plantilla_mensaje where organization_id = $1 and aprobada_por_tenant and activa;`, organizationId);
    return { unidades, feeds, unidadesConTarifaBase, reglasComision, propiedadesConAccesoActivo, propietarios, plantillasAprobadas };
  }
}
