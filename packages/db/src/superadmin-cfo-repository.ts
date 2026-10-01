// Repositorio del dashboard ejecutivo CFO (SA-01/SA-05/SA-36) -- puerto contra las funciones
// `security definer` de packages/db/migrations/0030_superadmin_cfo_dashboard.sql.
//
// SESIONES: `getDashboardRows` y `listSnapshots` son caller-bound (`withAppSession({ userId:
// callerId })`); `getAlertInputsForSystem` y `snapshotForSystem` son SOLO-SISTEMA
// (`withAppSession({ userId: null })`). Esta clase no elige la sesion: recibe el
// `TenantDbSession` ya abierto.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada metodo corre bajo `runWithSavepointFallback`. Un
// SQLSTATE 42883/42P01/42703 (migracion 0030 sin aplicar) revierte SOLO el savepoint -- la
// transaccion de la sesion sigue viva para lo que el handler haga despues -- y devuelve
// `availability: "not_migrated"` con datos vacios; nunca un 500 ni un exito simulado. Cualquier
// otro error se repropaga tal cual.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { mapReport, type CostosAvailability, type CostReportRow, type PlanLimitRow, type ReportRaw } from "./superadmin-costos-planes-repository.ts";

/** Una fila por organizacion: lo del reporte de costo/margen + cobranza, limites del plan y tipo de cambio. */
export interface CfoOrgRow extends CostReportRow {
  /** `organization_billing.current_period_end` en ms (null = sin suscripcion). */
  readonly billingPeriodEndMs: number | null;
  readonly limites: readonly PlanLimitRow[];
  /** Tipo de cambio vigente para el mes consultado (null = no hay uno configurado). */
  readonly mxnPorUsd: number | null;
  readonly fxFecha: string | null;
  readonly fxFuente: string | null;
}

export interface BillingSnapshotRow {
  readonly organizationId: string;
  /** `YYYY-MM-01`. */
  readonly mes: string;
  readonly vertical: string;
  readonly orgStatus: string;
  readonly planId: string | null;
  readonly billingStatus: string | null;
  /** Centavos MXN; null = no se sabe (ver `mrrRazon`), jamas 0. */
  readonly mrrCentavos: number | null;
  readonly mrrRazon: "sin_plan" | "precio_no_configurado" | null;
}

export interface CfoRepository {
  /** CALLER. `month` = `YYYY-MM-DD` (cualquier dia del mes) o null = mes actual. */
  getDashboardRows(callerId: string, month: string | null): Promise<{ availability: CostosAvailability; rows: readonly CfoOrgRow[] }>;
  /** CALLER. Fotos mensuales entre dos meses (inclusive). */
  listSnapshots(callerId: string, desde: string, hasta: string): Promise<{ availability: CostosAvailability; snapshots: readonly BillingSnapshotRow[] }>;
  /** SISTEMA. Mismas filas que el dashboard, para el cron de alertas. */
  getAlertInputsForSystem(month: string | null): Promise<{ availability: CostosAvailability; rows: readonly CfoOrgRow[] }>;
  /** SISTEMA. Foto del mes en curso; `filas` = organizaciones escritas. */
  snapshotForSystem(): Promise<{ availability: CostosAvailability; filas: number | null }>;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-cfo-repository: las funciones/tablas de 0030_superadmin_cfo_dashboard.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible aun' (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para habilitar el dashboard CFO, el NRR y las alertas.",
  );
}

async function guarded<TOk, TMissing>(db: TenantDbSession, run: () => Promise<TOk>, onMissing: () => TMissing): Promise<TOk | TMissing> {
  return runWithSavepointFallback<TOk | TMissing>({
    session: db,
    primary: run,
    isRecoverable: (err) => isMigrationPendingError(err),
    fallback: async () => {
      warnOnce();
      return onMissing();
    },
  });
}

interface OrgRowRaw extends ReportRaw {
  billing_period_end: string | Date | null;
  limites: ReadonlyArray<{ metrica: PlanLimitRow["metrica"]; limite: string | number; accion: PlanLimitRow["accion"] }> | null;
  mxn_por_usd: string | number | null;
  fx_fecha: string | null;
  fx_fuente: string | null;
}

function mapOrgRow(r: OrgRowRaw): CfoOrgRow {
  return {
    ...mapReport(r),
    billingPeriodEndMs: r.billing_period_end === null ? null : new Date(r.billing_period_end).getTime(),
    limites: (r.limites ?? []).map((l) => ({ metrica: l.metrica, limite: Number(l.limite), accion: l.accion })),
    mxnPorUsd: r.mxn_por_usd === null ? null : Number(r.mxn_por_usd),
    fxFecha: r.fx_fecha,
    fxFuente: r.fx_fuente,
  };
}

// `fx_fecha::text` y `mes::text`: el driver `pg` devuelve las columnas `date` como Date a medianoche
// local, lo que corre el dia segun la zona horaria del proceso. Como texto llega tal cual.
const ORG_COLS = `organization_id, organization_name, organization_slug, vertical, org_status, plan_id, plan_nombre,
  precio_base_mxn_centavos, precio_asiento_mxn_centavos, asientos_incluidos, billing_status, billing_seats, billing_period_end,
  sucursales_activas, llm_micro_usd, voz_micro_usd, whatsapp_micro_usd, telefonia_micro_usd, otros_micro_usd, eventos_total,
  eventos_estimados, minutos_voz, mensajes, llm_cap_micro_usd, llm_alert_pct, limites, mxn_por_usd, fx_fecha::text as fx_fecha, fx_fuente`;

export class PostgresCfoRepository implements CfoRepository {
  constructor(private readonly db: TenantDbSession) {}

  getDashboardRows(callerId: string, month: string | null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<OrgRowRaw>(`select ${ORG_COLS} from core.get_cfo_dashboard_for_superadmin($1, $2::date);`, [callerId, month]);
        return { availability: "available" as const, rows: rows.map(mapOrgRow) };
      },
      () => ({ availability: "not_migrated" as const, rows: [] as readonly CfoOrgRow[] }),
    );
  }

  listSnapshots(callerId: string, desde: string, hasta: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{
          organization_id: string;
          mes: string;
          vertical: string;
          org_status: string;
          plan_id: string | null;
          billing_status: string | null;
          mrr_mxn_centavos: string | number | null;
          mrr_razon: BillingSnapshotRow["mrrRazon"];
        }>(
          `select organization_id, mes::text as mes, vertical, org_status, plan_id, billing_status, mrr_mxn_centavos, mrr_razon
             from core.list_billing_snapshots_for_superadmin($1, $2::date, $3::date);`,
          [callerId, desde, hasta],
        );
        return {
          availability: "available" as const,
          snapshots: rows.map((r) => ({
            organizationId: r.organization_id,
            mes: r.mes,
            vertical: r.vertical,
            orgStatus: r.org_status,
            planId: r.plan_id,
            billingStatus: r.billing_status,
            mrrCentavos: r.mrr_mxn_centavos === null ? null : Number(r.mrr_mxn_centavos),
            mrrRazon: r.mrr_razon,
          })),
        };
      },
      () => ({ availability: "not_migrated" as const, snapshots: [] as readonly BillingSnapshotRow[] }),
    );
  }

  getAlertInputsForSystem(month: string | null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<OrgRowRaw>(`select ${ORG_COLS} from core.get_cfo_alert_inputs_for_system($1::date);`, [month]);
        return { availability: "available" as const, rows: rows.map(mapOrgRow) };
      },
      () => ({ availability: "not_migrated" as const, rows: [] as readonly CfoOrgRow[] }),
    );
  }

  snapshotForSystem() {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ filas: number | string }>(`select core.snapshot_billing_monthly_for_system() as filas;`);
        return { availability: "available" as const, filas: rows[0] ? Number(rows[0].filas) : null };
      },
      () => ({ availability: "not_migrated" as const, filas: null as number | null }),
    );
  }
}

/** Adaptador en memoria para los tests de rutas y del cron (misma semantica de acceso que el SQL). */
export class InMemoryCfoRepository implements CfoRepository {
  private readonly superadmins = new Set<string>();
  private rows: CfoOrgRow[] = [];
  private snapshots: BillingSnapshotRow[] = [];
  snapshotLlamadas = 0;
  constructor(private readonly opciones: { readonly migrado?: boolean } = {}) {}

  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  seedRows(rows: readonly CfoOrgRow[]): void {
    this.rows = [...rows];
  }
  seedSnapshots(snapshots: readonly BillingSnapshotRow[]): void {
    this.snapshots = [...snapshots];
  }

  private get migrado(): boolean {
    return this.opciones.migrado ?? true;
  }

  async getDashboardRows(callerId: string, _month: string | null) {
    if (!this.migrado) return { availability: "not_migrated" as const, rows: [] as readonly CfoOrgRow[] };
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, rows: [] as readonly CfoOrgRow[] };
    return { availability: "available" as const, rows: this.rows };
  }
  async listSnapshots(callerId: string, desde: string, hasta: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, snapshots: [] as readonly BillingSnapshotRow[] };
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, snapshots: [] as readonly BillingSnapshotRow[] };
    return { availability: "available" as const, snapshots: this.snapshots.filter((s) => s.mes.slice(0, 7) >= desde.slice(0, 7) && s.mes.slice(0, 7) <= hasta.slice(0, 7)) };
  }
  async getAlertInputsForSystem(_month: string | null) {
    if (!this.migrado) return { availability: "not_migrated" as const, rows: [] as readonly CfoOrgRow[] };
    return { availability: "available" as const, rows: this.rows };
  }
  async snapshotForSystem() {
    this.snapshotLlamadas += 1;
    if (!this.migrado) return { availability: "not_migrated" as const, filas: null as number | null };
    return { availability: "available" as const, filas: this.rows.length };
  }
}
