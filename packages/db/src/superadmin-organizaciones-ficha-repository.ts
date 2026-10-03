// Repositorio de la tabla de Organizaciones (SA-L-20), la Ficha 360 (SA-07) y el onboarding medido (SA-18) -- puerto contra las
// funciones de packages/db/migrations/0052_superadmin_organizaciones_ficha_onboarding.sql.
//
// SESIONES: los metodos de lectura son caller-bound (`withAppSession({ userId: callerId })`); `avisarListasForSystem` es de SOLO
// SISTEMA (`withAppSession({ userId: null })`). Esta clase no elige la sesion, recibe el `TenantDbSession` ya abierto.
//
// CADA FUENTE FALLA POR SEPARADO (mismo criterio que superadmin-consola-repository.ts): cada metodo corre bajo
// `runWithSavepointFallback`; un error SQL revierte SOLO su savepoint y devuelve `{ ok: false, razon }`:
//   * `no_migrado` -- SQLSTATE 42883/42P01/42703 (la 0052 no esta aplicada en este despliegue);
//   * `error`      -- cualquier otro error SQL (solo se registra su SQLSTATE).
// Nunca un 500 ni un valor simulado: el llamador responde `disponible: false` o deja el campo en null con su razon.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import type { FuenteConsola } from "./superadmin-consola-repository.ts";

export type OrgOnboardingEstado = "hecho" | "pendiente" | "no_se_pudo_medir";

export interface OrgOnboardingPaso {
  readonly paso: string;
  readonly titulo: string;
  readonly estado: OrgOnboardingEstado;
  /** Solo con `no_se_pudo_medir` (o un conteo con razon): `fuente_no_migrada` | `sin_fuente`. */
  readonly razon: string | null;
}

export interface OrgOnboardingResumenRow {
  readonly organizationId: string;
  readonly hechos: number;
  readonly total: number;
  readonly noMedibles: number;
}

export interface OrgMetricaRow {
  readonly organizationId: string;
  /** `null` + `operacionesRazon` = no medible (despachos no persiste operaciones; vertical sin migrar). */
  readonly operaciones30d: number | null;
  readonly operacionesRazon: string | null;
  /** `null` = la fuente de costo no existe todavia (0 = se leyo y no hubo consumo). */
  readonly llm30dMicroUsd: number | null;
  readonly eventos30dMicroUsd: number | null;
  /** Plan asignado (sin precios). `planId = null` + `planRazon = null` = sin plan; `planRazon` = la fuente no existe todavia. */
  readonly planId: string | null;
  readonly planNombre: string | null;
  readonly planRazon: string | null;
}

export interface OrgFichaValor {
  readonly valor: number | null;
  readonly razon: string | null;
}

/** Forma jsonb de `core.get_org_ficha_for_superadmin` (camelCase: la arma el SQL). */
export interface OrgFicha {
  readonly organizacion: { readonly id: string; readonly nombre: string; readonly slug: string; readonly vertical: string; readonly estado: string; readonly creadaEn: string };
  readonly uso: { readonly operaciones30d: OrgFichaValor; readonly conversaciones30d: OrgFichaValor; readonly minutosVoz30d: OrgFichaValor };
  readonly costo: { readonly llm30dMicroUsd: number | null; readonly eventos30dMicroUsd: number | null; readonly eventos30dTotal: number | null; readonly razon: string | null };
  readonly membresias: {
    readonly porRol: readonly { readonly rol: string; readonly cantidad: number }[];
    readonly ultimosAccesos: readonly { readonly rol: string; readonly ultimoAcceso: string | null }[] | null;
    readonly ultimosAccesosRazon: string | null;
  };
  readonly errores: {
    readonly outboxMuerto: OrgFichaValor;
    readonly denegaciones30d: { readonly valor: number | null; readonly ultimas: readonly { readonly ruta: string; readonly motivo: string | null; readonly cuando: string }[] | null; readonly razon: string | null };
    readonly crons: OrgFichaValor;
  };
  readonly facturacion: {
    readonly plan: { readonly id: string; readonly nombre: string } | null;
    readonly cobro: { readonly estado: string; readonly periodoHasta: string | null; readonly asientos: number } | null;
    readonly contrato: { readonly contractId: string; readonly version: number | null } | null;
  };
  readonly onboarding: readonly OrgOnboardingPaso[];
}

export interface OrgFichaRepository {
  /** CALLER. Operaciones y costo de IA a 30 dias de TODAS las organizaciones; `hoy` = `YYYY-MM-DD` (dia de Mexico). */
  metricas(callerId: string, hoy: string): Promise<FuenteConsola<readonly OrgMetricaRow[]>>;
  /** CALLER. 'x/y' de onboarding de todas las organizaciones. */
  onboardingResumen(callerId: string): Promise<FuenteConsola<readonly OrgOnboardingResumenRow[]>>;
  /** CALLER. Checklist de una organizacion (vacio si no existe). */
  onboarding(callerId: string, organizationId: string): Promise<FuenteConsola<readonly OrgOnboardingPaso[]>>;
  /** CALLER. Ficha 360; `data = null` = la organizacion no existe. */
  ficha(callerId: string, organizationId: string, hoy: string): Promise<FuenteConsola<OrgFicha | null>>;
  /**
   * SISTEMA. Marca (marcador persistente, una sola vez) las organizaciones con el checklist COMPLETO y devuelve los ids que hay que avisar.
   * NO emite nada: el cron emite 'organizacion lista' con el productor compartido en la MISMA transaccion (si falla, revierte el marcador).
   */
  avisarListasForSystem(): Promise<FuenteConsola<readonly string[]>>;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-organizaciones-ficha-repository: las funciones de 0052_superadmin_organizaciones_ficha_onboarding.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible aun' (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para habilitar las metricas, la ficha y el onboarding por organizacion.",
  );
}

function pgCode(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "desconocido";
}

/** Una fuente = un SAVEPOINT: cualquier error SQL la deja en `{ ok: false }` y la transaccion sigue viva. */
async function guarded<T>(db: TenantDbSession, fuente: string, run: () => Promise<T>): Promise<FuenteConsola<T>> {
  return runWithSavepointFallback<FuenteConsola<T>>({
    session: db,
    primary: async () => ({ ok: true as const, data: await run() }),
    isRecoverable: () => true,
    fallback: async (err) => {
      if (isMigrationPendingError(err)) {
        warnOnce();
        return { ok: false as const, razon: "no_migrado" as const };
      }
      console.error(`superadmin-organizaciones-ficha-repository: la fuente '${fuente}' fallo (SQLSTATE ${pgCode(err)}).`);
      return { ok: false as const, razon: "error" as const };
    },
  });
}

const num = (v: string | number | null | undefined): number => Number(v ?? 0);
const numOrNull = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export class PostgresOrgFichaRepository implements OrgFichaRepository {
  constructor(private readonly db: TenantDbSession) {}

  metricas(callerId: string, hoy: string) {
    return guarded(this.db, "metricas", async () => {
      const { rows } = await this.db.query<{
        organization_id: string;
        operaciones_30d: string | number | null;
        operaciones_razon: string | null;
        llm_30d_micro_usd: string | number | null;
        eventos_30d_micro_usd: string | number | null;
        plan_id: string | null;
        plan_nombre: string | null;
        plan_razon: string | null;
      }>(`select organization_id, operaciones_30d, operaciones_razon, llm_30d_micro_usd, eventos_30d_micro_usd, plan_id, plan_nombre, plan_razon from core.get_orgs_metricas_for_superadmin($1, $2::date);`, [callerId, hoy]);
      return rows.map((r) => ({
        organizationId: r.organization_id,
        operaciones30d: numOrNull(r.operaciones_30d),
        operacionesRazon: r.operaciones_razon,
        llm30dMicroUsd: numOrNull(r.llm_30d_micro_usd),
        eventos30dMicroUsd: numOrNull(r.eventos_30d_micro_usd),
        planId: r.plan_id,
        planNombre: r.plan_nombre,
        planRazon: r.plan_razon,
      }));
    });
  }

  onboardingResumen(callerId: string) {
    return guarded(this.db, "onboarding_resumen", async () => {
      const { rows } = await this.db.query<{ organization_id: string; hechos: string | number; total: string | number; no_medibles: string | number }>(
        `select organization_id, hechos, total, no_medibles from core.get_orgs_onboarding_resumen_for_superadmin($1);`,
        [callerId],
      );
      return rows.map((r) => ({ organizationId: r.organization_id, hechos: num(r.hechos), total: num(r.total), noMedibles: num(r.no_medibles) }));
    });
  }

  onboarding(callerId: string, organizationId: string) {
    return guarded(this.db, "onboarding", async () => {
      const { rows } = await this.db.query<{ paso: string; titulo: string; estado: OrgOnboardingEstado; razon: string | null }>(
        `select paso, titulo, estado, razon from core.get_org_onboarding_for_superadmin($1, $2::uuid) order by orden;`,
        [callerId, organizationId],
      );
      return rows.map((r) => ({ paso: r.paso, titulo: r.titulo, estado: r.estado, razon: r.razon }));
    });
  }

  ficha(callerId: string, organizationId: string, hoy: string) {
    return guarded(this.db, "ficha", async () => {
      const { rows } = await this.db.query<{ ficha: OrgFicha }>(`select ficha from core.get_org_ficha_for_superadmin($1, $2::uuid, $3::date);`, [callerId, organizationId, hoy]);
      return rows[0]?.ficha ?? null;
    });
  }

  avisarListasForSystem() {
    return guarded(this.db, "avisar_listas", async () => {
      const { rows } = await this.db.query<{ organization_id: string }>(`select organization_id from core.avisar_organizaciones_listas_for_system();`);
      return rows.map((r) => r.organization_id);
    });
  }
}

type SeedFuente = {
  metricas: FuenteConsola<readonly OrgMetricaRow[]>;
  onboardingResumen: FuenteConsola<readonly OrgOnboardingResumenRow[]>;
  onboarding: FuenteConsola<readonly OrgOnboardingPaso[]>;
  /** Por organizacion; una organizacion sin entrada = no existe (`data: null`). */
  fichas: ReadonlyMap<string, OrgFicha> | "no_migrado";
  avisar: FuenteConsola<readonly string[]>;
};

const NO_MIGRADO = { ok: false, razon: "no_migrado" } as const;

/**
 * Adaptador en memoria para los tests de rutas. Misma semantica de acceso que el SQL: un caller que no es superadmin recibe
 * cero filas (`ok: true` con lista vacia; la ficha, `null`). Sin sembrar, devuelve `no_migrado` (la base sin migrar).
 */
export class InMemoryOrgFichaRepository implements OrgFichaRepository {
  private readonly superadmins = new Set<string>();
  private fuentes: SeedFuente = { metricas: NO_MIGRADO, onboardingResumen: NO_MIGRADO, onboarding: NO_MIGRADO, fichas: "no_migrado", avisar: NO_MIGRADO };
  readonly llamadas = { metricas: [] as string[], ficha: [] as Array<{ organizationId: string; hoy: string }>, avisar: 0 };

  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  seed(parche: Partial<SeedFuente>): void {
    this.fuentes = { ...this.fuentes, ...parche };
  }

  private lectura<T extends readonly unknown[]>(callerId: string, f: FuenteConsola<T>): FuenteConsola<T> {
    if (!f.ok) return f;
    return this.superadmins.has(callerId) ? f : { ok: true, data: [] as unknown as T };
  }

  async metricas(callerId: string, hoy: string) {
    this.llamadas.metricas.push(hoy);
    return this.lectura(callerId, this.fuentes.metricas);
  }
  async onboardingResumen(callerId: string) {
    return this.lectura(callerId, this.fuentes.onboardingResumen);
  }
  async onboarding(callerId: string, _organizationId: string) {
    return this.lectura(callerId, this.fuentes.onboarding);
  }
  async ficha(callerId: string, organizationId: string, hoy: string): Promise<FuenteConsola<OrgFicha | null>> {
    this.llamadas.ficha.push({ organizationId, hoy });
    if (this.fuentes.fichas === "no_migrado") return NO_MIGRADO;
    if (!this.superadmins.has(callerId)) return { ok: true, data: null };
    return { ok: true, data: this.fuentes.fichas.get(organizationId) ?? null };
  }
  async avisarListasForSystem() {
    this.llamadas.avisar += 1;
    return this.fuentes.avisar;
  }
}
