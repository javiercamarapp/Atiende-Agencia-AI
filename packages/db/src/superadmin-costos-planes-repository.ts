// Repositorio del superadmin "CFO": costo por evento por organizacion (SA-02), tipo de
// cambio, catalogo de planes/limites y asignacion de planes (SA-03) -- puerto contra las
// funciones `security definer` de packages/db/migrations/0027_superadmin_costos_planes.sql.
//
// SESIONES (ver la cabecera de la migracion): `recordEvent` es SOLO-SISTEMA (el llamador
// la invoca en `withAppSession({ userId: null })`); todo lo demas es caller-bound
// (`withAppSession({ userId: callerId })`). Estas clases no eligen la sesion: reciben el
// `TenantDbSession` ya abierto.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada metodo corre bajo `runWithSavepointFallback`
// -- un SQLSTATE 42883/42P01/42703 (migracion 0027 sin aplicar) revierte SOLO el
// savepoint (la transaccion de la sesion sigue viva) y devuelve `availability:
// "not_migrated"` con datos vacios; nunca 500 ni exito simulado. Los errores de negocio
// de la base (42501/22023/P0002/55006/23505/23514) se traducen a `SuperadminSeguridadError`
// tipado (el mismo que ya traduce `traducirErrorSeguridad` en la capa de rutas).
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { SuperadminSeguridadError } from "./superadmin-seguridad-repository.ts";

export type CostosAvailability = "available" | "not_migrated";

export type MetricaLimiteRow = "llm_costo_micro_usd_mes" | "minutos_voz_mes" | "mensajes_mes" | "sucursales" | "asientos";
export type AccionLimiteRow = "avisar" | "cobrar" | "pausar";
export type CategoriaEventoCosto = "voz" | "whatsapp" | "telefonia" | "sms" | "email" | "storage";
export type UnidadEventoCosto = "segundo" | "minuto" | "mensaje" | "conversacion" | "unidad";
export type VerticalCostos = "hoteles" | "restaurantes" | "rentas" | "licitaciones" | "citas" | "despachos";

export const VERTICALES_COSTOS: readonly VerticalCostos[] = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"];
export const METRICAS_LIMITE: readonly MetricaLimiteRow[] = ["llm_costo_micro_usd_mes", "minutos_voz_mes", "mensajes_mes", "sucursales", "asientos"];
export const ACCIONES_LIMITE: readonly AccionLimiteRow[] = ["avisar", "cobrar", "pausar"];

export interface CostReportRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly vertical: string;
  readonly orgStatus: string;
  readonly planId: string | null;
  readonly planNombre: string | null;
  readonly precioBaseCentavos: number | null;
  readonly precioAsientoCentavos: number | null;
  readonly asientosIncluidos: number | null;
  readonly billingStatus: string | null;
  readonly billingSeats: number | null;
  readonly sucursalesActivas: number;
  readonly llmMicroUsd: number;
  readonly vozMicroUsd: number;
  readonly whatsappMicroUsd: number;
  readonly telefoniaMicroUsd: number;
  readonly otrosMicroUsd: number;
  readonly eventosTotal: number;
  readonly eventosEstimados: number;
  readonly minutosVoz: number;
  readonly mensajes: number;
  readonly llmCapMicroUsd: number;
  readonly llmAlertPct: number;
}

export interface FxRateRow {
  readonly fecha: string;
  readonly mxnPorUsd: number;
  readonly fuente: string;
}

export interface UsageCostEventRow {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly vertical: string;
  readonly occurredAtMs: number;
  readonly categoria: CategoriaEventoCosto;
  readonly proveedor: string;
  readonly unidad: UnidadEventoCosto;
  readonly cantidad: number;
  readonly costoMicroUsd: number;
  readonly costoEstimado: boolean;
  readonly refTipo: string;
  readonly refId: string;
}

export interface RecordUsageCostEventInput {
  readonly organizationId: string;
  readonly propertyId?: string | null;
  readonly occurredAtMs?: number | null;
  readonly categoria: CategoriaEventoCosto;
  readonly proveedor: string;
  readonly unidad: UnidadEventoCosto;
  readonly cantidad: number;
  readonly costoMicroUsd: number;
  readonly costoEstimado?: boolean;
  readonly refTipo: string;
  readonly refId: string;
}

export interface PlanLimitRow {
  readonly metrica: MetricaLimiteRow;
  readonly limite: number;
  readonly accion: AccionLimiteRow;
}

export interface PlanRow {
  readonly id: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly precioBaseCentavos: number | null;
  readonly precioAsientoCentavos: number | null;
  readonly asientosIncluidos: number;
  readonly activo: boolean;
  readonly limites: readonly PlanLimitRow[];
  readonly organizaciones: number;
  readonly updatedAtMs: number;
}

export interface UpsertPlanInput {
  readonly id: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly precioBaseCentavos: number | null;
  readonly precioAsientoCentavos: number | null;
  readonly asientosIncluidos: number;
  readonly activo: boolean;
}

export type PlanAssignmentEstado = "pending" | "executed" | "cancelled" | "expired";

export interface PlanAssignmentRow {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string | null;
  readonly planId: string;
  readonly motivo: string;
  readonly estado: PlanAssignmentEstado;
  readonly creadoPor: string;
  readonly creadoEnMs: number;
  readonly venceEnMs: number;
  readonly confirmadoPor: string | null;
  readonly confirmadoEnMs: number | null;
  readonly resultado: Readonly<Record<string, unknown>> | null;
}

export interface CostosPlanesRepository {
  /** SISTEMA. `inserted: false` = el mismo (refTipo, refId) ya estaba registrado. */
  recordEvent(input: RecordUsageCostEventInput): Promise<{ availability: CostosAvailability; inserted: boolean | null }>;
  /** CALLER. `month` = `YYYY-MM-DD` (cualquier dia del mes) o null = mes actual. */
  getReport(callerId: string, month: string | null): Promise<{ availability: CostosAvailability; rows: readonly CostReportRow[] }>;
  listEvents(callerId: string, organizationId: string, limit?: number): Promise<{ availability: CostosAvailability; events: readonly UsageCostEventRow[] }>;
  listFxRates(callerId: string, limit?: number): Promise<{ availability: CostosAvailability; rates: readonly FxRateRow[] }>;
  setFxRate(callerId: string, fecha: string, mxnPorUsd: number, fuente: string): Promise<{ availability: CostosAvailability }>;
  listPlans(callerId: string): Promise<{ availability: CostosAvailability; plans: readonly PlanRow[] }>;
  upsertPlan(callerId: string, plan: UpsertPlanInput): Promise<{ availability: CostosAvailability }>;
  setPlanLimit(callerId: string, planId: string, metrica: MetricaLimiteRow, limite: number, accion: AccionLimiteRow): Promise<{ availability: CostosAvailability }>;
  deletePlanLimit(callerId: string, planId: string, metrica: MetricaLimiteRow): Promise<{ availability: CostosAvailability }>;
  requestAssignment(callerId: string, organizationId: string, planId: string, motivo: string): Promise<{ availability: CostosAvailability; assignment: PlanAssignmentRow | null }>;
  confirmAssignment(callerId: string, requestId: string): Promise<{ availability: CostosAvailability; assignment: PlanAssignmentRow | null }>;
  cancelAssignment(callerId: string, requestId: string): Promise<{ availability: CostosAvailability; assignment: PlanAssignmentRow | null }>;
  listAssignments(callerId: string, limit?: number): Promise<{ availability: CostosAvailability; assignments: readonly PlanAssignmentRow[] }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Postgres
// ═══════════════════════════════════════════════════════════════════════════
function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function toTypedError(err: unknown): SuperadminSeguridadError | null {
  const message = err instanceof Error ? err.message : String(err);
  switch (pgCode(err)) {
    case "42501":
      return new SuperadminSeguridadError(message, "forbidden");
    case "22023":
    case "23514":
    case "22P02":
      return new SuperadminSeguridadError(message, "invalid");
    case "P0002":
      return new SuperadminSeguridadError(message, "not_found");
    case "55006":
    case "23505":
      return new SuperadminSeguridadError(message, "conflict");
    default:
      return null;
  }
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-costos-planes-repository: las funciones/tablas de 0027_superadmin_costos_planes.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible aun' (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para habilitar costo por evento, margen y catalogo de planes.",
  );
}

/** Corre `run` bajo SAVEPOINT; base sin migrar -> `onMissing()`; error de negocio -> error tipado. */
async function guarded<TOk, TMissing>(db: TenantDbSession, run: () => Promise<TOk>, onMissing: () => TMissing): Promise<TOk | TMissing> {
  try {
    return await runWithSavepointFallback<TOk | TMissing>({
      session: db,
      primary: run,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        warnOnce();
        return onMissing();
      },
    });
  } catch (err) {
    throw toTypedError(err) ?? err;
  }
}

const num = (v: string | number | null): number => (v === null ? 0 : Number(v));
const numOrNull = (v: string | number | null): number | null => (v === null ? null : Number(v));

interface ReportRaw {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  vertical: string;
  org_status: string;
  plan_id: string | null;
  plan_nombre: string | null;
  precio_base_mxn_centavos: string | number | null;
  precio_asiento_mxn_centavos: string | number | null;
  asientos_incluidos: number | null;
  billing_status: string | null;
  billing_seats: number | null;
  sucursales_activas: number;
  llm_micro_usd: string | number;
  voz_micro_usd: string | number;
  whatsapp_micro_usd: string | number;
  telefonia_micro_usd: string | number;
  otros_micro_usd: string | number;
  eventos_total: string | number;
  eventos_estimados: string | number;
  minutos_voz: string | number;
  mensajes: string | number;
  llm_cap_micro_usd: string | number;
  llm_alert_pct: string | number;
}

function mapReport(r: ReportRaw): CostReportRow {
  return {
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    organizationSlug: r.organization_slug,
    vertical: r.vertical,
    orgStatus: r.org_status,
    planId: r.plan_id,
    planNombre: r.plan_nombre,
    precioBaseCentavos: numOrNull(r.precio_base_mxn_centavos),
    precioAsientoCentavos: numOrNull(r.precio_asiento_mxn_centavos),
    asientosIncluidos: r.asientos_incluidos,
    billingStatus: r.billing_status,
    billingSeats: r.billing_seats,
    sucursalesActivas: r.sucursales_activas,
    llmMicroUsd: num(r.llm_micro_usd),
    vozMicroUsd: num(r.voz_micro_usd),
    whatsappMicroUsd: num(r.whatsapp_micro_usd),
    telefoniaMicroUsd: num(r.telefonia_micro_usd),
    otrosMicroUsd: num(r.otros_micro_usd),
    eventosTotal: num(r.eventos_total),
    eventosEstimados: num(r.eventos_estimados),
    minutosVoz: num(r.minutos_voz),
    mensajes: num(r.mensajes),
    llmCapMicroUsd: num(r.llm_cap_micro_usd),
    llmAlertPct: num(r.llm_alert_pct),
  };
}

interface EventRaw {
  id: string;
  organization_id: string;
  property_id: string | null;
  vertical: string;
  occurred_at: string;
  categoria: CategoriaEventoCosto;
  proveedor: string;
  unidad: UnidadEventoCosto;
  cantidad: string | number;
  costo_micro_usd: string | number;
  costo_estimado: boolean;
  ref_tipo: string;
  ref_id: string;
}

interface PlanRaw {
  id: string;
  nombre: string;
  vertical: string;
  precio_base_mxn_centavos: string | number | null;
  precio_asiento_mxn_centavos: string | number | null;
  asientos_incluidos: number;
  activo: boolean;
  limites: ReadonlyArray<{ metrica: MetricaLimiteRow; limite: string | number; accion: AccionLimiteRow }> | null;
  organizaciones: number;
  updated_at: string;
}

interface AssignmentRaw {
  id: string;
  organization_id: string;
  organization_name?: string | null;
  plan_id: string;
  motivo: string;
  estado: PlanAssignmentEstado;
  creado_por: string;
  creado_en: string;
  vence_en: string;
  confirmado_por: string | null;
  confirmado_en: string | null;
  resultado: Record<string, unknown> | null;
}

function mapAssignment(r: AssignmentRaw): PlanAssignmentRow {
  return {
    id: r.id,
    organizationId: r.organization_id,
    organizationName: r.organization_name ?? null,
    planId: r.plan_id,
    motivo: r.motivo,
    estado: r.estado,
    creadoPor: r.creado_por,
    creadoEnMs: new Date(r.creado_en).getTime(),
    venceEnMs: new Date(r.vence_en).getTime(),
    confirmadoPor: r.confirmado_por,
    confirmadoEnMs: r.confirmado_en ? new Date(r.confirmado_en).getTime() : null,
    resultado: r.resultado,
  };
}

export class PostgresCostosPlanesRepository implements CostosPlanesRepository {
  constructor(private readonly db: TenantDbSession) {}

  recordEvent(input: RecordUsageCostEventInput) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ inserted: boolean }>(
          `select core.record_usage_cost_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as inserted;`,
          [
            input.organizationId,
            input.propertyId ?? null,
            input.occurredAtMs === null || input.occurredAtMs === undefined ? null : new Date(input.occurredAtMs).toISOString(),
            input.categoria,
            input.proveedor,
            input.unidad,
            input.cantidad,
            Math.round(input.costoMicroUsd),
            input.costoEstimado ?? true,
            input.refTipo,
            input.refId,
          ],
        );
        return { availability: "available" as const, inserted: rows[0]?.inserted ?? null };
      },
      () => ({ availability: "not_migrated" as const, inserted: null }),
    );
  }

  getReport(callerId: string, month: string | null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<ReportRaw>(`select * from core.get_cost_margin_report_for_superadmin($1, $2::date);`, [callerId, month]);
        return { availability: "available" as const, rows: rows.map(mapReport) };
      },
      () => ({ availability: "not_migrated" as const, rows: [] as readonly CostReportRow[] }),
    );
  }

  listEvents(callerId: string, organizationId: string, limit = 100) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<EventRaw>(`select * from core.list_usage_cost_events_for_superadmin($1, $2, $3);`, [callerId, organizationId, limit]);
        return {
          availability: "available" as const,
          events: rows.map(
            (r): UsageCostEventRow => ({
              id: r.id,
              organizationId: r.organization_id,
              propertyId: r.property_id,
              vertical: r.vertical,
              occurredAtMs: new Date(r.occurred_at).getTime(),
              categoria: r.categoria,
              proveedor: r.proveedor,
              unidad: r.unidad,
              cantidad: num(r.cantidad),
              costoMicroUsd: num(r.costo_micro_usd),
              costoEstimado: r.costo_estimado,
              refTipo: r.ref_tipo,
              refId: r.ref_id,
            }),
          ),
        };
      },
      () => ({ availability: "not_migrated" as const, events: [] as readonly UsageCostEventRow[] }),
    );
  }

  listFxRates(callerId: string, limit = 30) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ fecha: string | Date; mxn_por_usd: string | number; fuente: string }>(
          `select to_char(fecha, 'YYYY-MM-DD') as fecha, mxn_por_usd, fuente from core.list_fx_rates_for_superadmin($1, $2);`,
          [callerId, limit],
        );
        return { availability: "available" as const, rates: rows.map((r): FxRateRow => ({ fecha: String(r.fecha), mxnPorUsd: num(r.mxn_por_usd), fuente: r.fuente })) };
      },
      () => ({ availability: "not_migrated" as const, rates: [] as readonly FxRateRow[] }),
    );
  }

  setFxRate(callerId: string, fecha: string, mxnPorUsd: number, fuente: string) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_set_fx_rate($1, $2::date, $3, $4);`, [callerId, fecha, mxnPorUsd, fuente]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  listPlans(callerId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<PlanRaw>(`select * from core.list_plans_for_superadmin($1);`, [callerId]);
        return {
          availability: "available" as const,
          plans: rows.map(
            (r): PlanRow => ({
              id: r.id,
              nombre: r.nombre,
              vertical: r.vertical,
              precioBaseCentavos: numOrNull(r.precio_base_mxn_centavos),
              precioAsientoCentavos: numOrNull(r.precio_asiento_mxn_centavos),
              asientosIncluidos: r.asientos_incluidos,
              activo: r.activo,
              limites: (r.limites ?? []).map((l) => ({ metrica: l.metrica, limite: Number(l.limite), accion: l.accion })),
              organizaciones: r.organizaciones,
              updatedAtMs: new Date(r.updated_at).getTime(),
            }),
          ),
        };
      },
      () => ({ availability: "not_migrated" as const, plans: [] as readonly PlanRow[] }),
    );
  }

  upsertPlan(callerId: string, plan: UpsertPlanInput) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_upsert_plan($1, $2, $3, $4, $5, $6, $7, $8);`, [
          callerId,
          plan.id,
          plan.nombre,
          plan.vertical,
          plan.precioBaseCentavos,
          plan.precioAsientoCentavos,
          plan.asientosIncluidos,
          plan.activo,
        ]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  setPlanLimit(callerId: string, planId: string, metrica: MetricaLimiteRow, limite: number, accion: AccionLimiteRow) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_set_plan_limit($1, $2, $3, $4, $5);`, [callerId, planId, metrica, limite, accion]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  deletePlanLimit(callerId: string, planId: string, metrica: MetricaLimiteRow) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_delete_plan_limit($1, $2, $3);`, [callerId, planId, metrica]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  requestAssignment(callerId: string, organizationId: string, planId: string, motivo: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<AssignmentRaw>(`select * from core.superadmin_request_plan_assignment($1, $2, $3, $4);`, [callerId, organizationId, planId, motivo]);
        const r = rows[0];
        if (!r) throw new Error("superadmin_request_plan_assignment no devolvio fila");
        return { availability: "available" as const, assignment: mapAssignment(r) };
      },
      () => ({ availability: "not_migrated" as const, assignment: null }),
    );
  }

  confirmAssignment(callerId: string, requestId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<AssignmentRaw>(`select * from core.superadmin_confirm_plan_assignment($1, $2);`, [callerId, requestId]);
        const r = rows[0];
        if (!r) throw new Error("superadmin_confirm_plan_assignment no devolvio fila");
        return { availability: "available" as const, assignment: mapAssignment(r) };
      },
      () => ({ availability: "not_migrated" as const, assignment: null }),
    );
  }

  cancelAssignment(callerId: string, requestId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<AssignmentRaw>(`select * from core.superadmin_cancel_plan_assignment($1, $2);`, [callerId, requestId]);
        const r = rows[0];
        if (!r) throw new Error("superadmin_cancel_plan_assignment no devolvio fila");
        return { availability: "available" as const, assignment: mapAssignment(r) };
      },
      () => ({ availability: "not_migrated" as const, assignment: null }),
    );
  }

  listAssignments(callerId: string, limit = 50) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<AssignmentRaw>(`select * from core.list_plan_assignments_for_superadmin($1, $2);`, [callerId, limit]);
        return { availability: "available" as const, assignments: rows.map(mapAssignment) };
      },
      () => ({ availability: "not_migrated" as const, assignments: [] as readonly PlanAssignmentRow[] }),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// En memoria (tests de rutas; replica las reglas de la migracion)
// ═══════════════════════════════════════════════════════════════════════════
interface InMemoryClock {
  readonly now?: () => number;
}

interface MemOrg {
  vertical: string;
  name: string;
  slug: string;
  status: "trial" | "active" | "suspended";
  sucursalesActivas: number;
  billingStatus: string | null;
  billingSeats: number | null;
  llmCapMicroUsd: number | null;
  llmAlertPct: number;
  llmUsage: Array<{ monthIso: string; costMicroUsd: number }>;
}

const ASSIGNMENT_TTL_MS = 10 * 60_000;
const PLAN_ID_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/u;
const DEFAULT_LLM_CAP_MICRO_USD = 100_000_000;

function mesDe(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

export class InMemoryCostosPlanesRepository implements CostosPlanesRepository {
  private readonly superadmins = new Set<string>();
  private readonly orgs = new Map<string, MemOrg>();
  private readonly events: UsageCostEventRow[] = [];
  private readonly fx = new Map<string, FxRateRow>();
  private readonly plans = new Map<string, Omit<PlanRow, "limites" | "organizaciones" | "updatedAtMs"> & { updatedAtMs: number }>();
  private readonly limits = new Map<string, PlanLimitRow>();
  private readonly orgPlan = new Map<string, string>();
  private readonly assignments: PlanAssignmentRow[] = [];
  readonly audit: Array<{ event: string; actor: string | null; organizationId: string | null; planId: string | null }> = [];
  private idSeq = 0;
  constructor(private readonly clock: InMemoryClock = {}) {
    const seeds: Array<[string, string, string, number | null, number | null, number]> = [
      ["hoteles-estandar", "Hoteles - por habitacion", "hoteles", 0, 8900, 5],
      ["restaurantes-estandar", "Restaurantes - por agente de voz", "restaurantes", 0, 79900, 1],
      ["citas-estandar", "Citas - por doctor/proveedor", "citas", 0, 59900, 0],
      ["rentas-estandar", "Rentas vacacionales - por configurar", "rentas", null, null, 0],
      ["licitaciones-estandar", "Licitaciones - por configurar", "licitaciones", null, null, 0],
      ["despachos-estandar", "Despachos - por configurar", "despachos", null, null, 0],
    ];
    for (const [id, nombre, vertical, base, asiento, incl] of seeds) {
      this.plans.set(id, { id, nombre, vertical, precioBaseCentavos: base, precioAsientoCentavos: asiento, asientosIncluidos: incl, activo: true, updatedAtMs: 0 });
    }
  }

  private now(): number {
    return (this.clock.now ?? Date.now)();
  }
  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  seedOrganization(id: string, org: Partial<MemOrg> & { vertical: string; name: string; slug: string }): void {
    this.orgs.set(id, { status: "active", sucursalesActivas: 0, billingStatus: null, billingSeats: null, llmCapMicroUsd: null, llmAlertPct: 80, llmUsage: [], ...org });
  }
  seedLlmUsage(organizationId: string, monthIso: string, costMicroUsd: number): void {
    this.orgs.get(organizationId)?.llmUsage.push({ monthIso, costMicroUsd });
  }
  organizationPlanId(organizationId: string): string | undefined {
    return this.orgPlan.get(organizationId);
  }
  organizationLlmCap(organizationId: string): number | null {
    return this.orgs.get(organizationId)?.llmCapMicroUsd ?? null;
  }

  private require(callerId: string): void {
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo un superadmin de plataforma real puede ejecutar esta accion", "forbidden");
  }
  private log(event: string, actor: string | null, organizationId: string | null, planId: string | null): void {
    this.audit.push({ event, actor, organizationId, planId });
  }

  async recordEvent(input: RecordUsageCostEventInput) {
    const org = this.orgs.get(input.organizationId);
    if (!org) throw new SuperadminSeguridadError("la organizacion no existe", "not_found");
    if (!["voz", "whatsapp", "telefonia", "sms", "email", "storage"].includes(input.categoria)) throw new SuperadminSeguridadError("categoria invalida", "invalid");
    if (!(input.costoMicroUsd >= 0) || !(input.cantidad >= 0)) throw new SuperadminSeguridadError("cantidad y costo deben ser >= 0", "invalid");
    if (this.events.some((e) => e.refTipo === input.refTipo && e.refId === input.refId)) return { availability: "available" as const, inserted: false };
    this.idSeq += 1;
    this.events.push({
      id: `evt-${this.idSeq}`,
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      vertical: org.vertical,
      occurredAtMs: input.occurredAtMs ?? this.now(),
      categoria: input.categoria,
      proveedor: input.proveedor,
      unidad: input.unidad,
      cantidad: input.cantidad,
      costoMicroUsd: Math.round(input.costoMicroUsd),
      costoEstimado: input.costoEstimado ?? true,
      refTipo: input.refTipo,
      refId: input.refId,
    });
    return { availability: "available" as const, inserted: true };
  }

  async getReport(callerId: string, month: string | null) {
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, rows: [] as readonly CostReportRow[] };
    const mes = month ? month.slice(0, 7) : mesDe(this.now());
    const rows: CostReportRow[] = [];
    for (const [id, o] of [...this.orgs.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      const evs = this.events.filter((e) => e.organizationId === id && mesDe(e.occurredAtMs) === mes);
      const suma = (cat: (c: CategoriaEventoCosto) => boolean) => evs.filter((e) => cat(e.categoria)).reduce((s, e) => s + e.costoMicroUsd, 0);
      const planId = this.orgPlan.get(id) ?? null;
      const plan = planId ? this.plans.get(planId) : undefined;
      rows.push({
        organizationId: id,
        organizationName: o.name,
        organizationSlug: o.slug,
        vertical: o.vertical,
        orgStatus: o.status,
        planId,
        planNombre: plan?.nombre ?? null,
        precioBaseCentavos: plan?.precioBaseCentavos ?? null,
        precioAsientoCentavos: plan?.precioAsientoCentavos ?? null,
        asientosIncluidos: plan?.asientosIncluidos ?? null,
        billingStatus: o.billingStatus,
        billingSeats: o.billingSeats,
        sucursalesActivas: o.sucursalesActivas,
        llmMicroUsd: o.llmUsage.filter((u) => u.monthIso === mes).reduce((s, u) => s + u.costMicroUsd, 0),
        vozMicroUsd: suma((c) => c === "voz"),
        whatsappMicroUsd: suma((c) => c === "whatsapp"),
        telefoniaMicroUsd: suma((c) => c === "telefonia"),
        otrosMicroUsd: suma((c) => c === "sms" || c === "email" || c === "storage"),
        eventosTotal: evs.length,
        eventosEstimados: evs.filter((e) => e.costoEstimado).length,
        minutosVoz: evs.filter((e) => e.categoria === "voz").reduce((s, e) => s + (e.unidad === "minuto" ? e.cantidad : e.unidad === "segundo" ? e.cantidad / 60 : 0), 0),
        mensajes: evs.filter((e) => e.categoria === "whatsapp" && e.unidad === "mensaje").reduce((s, e) => s + e.cantidad, 0),
        llmCapMicroUsd: o.llmCapMicroUsd ?? DEFAULT_LLM_CAP_MICRO_USD,
        llmAlertPct: o.llmAlertPct,
      });
    }
    return { availability: "available" as const, rows };
  }

  async listEvents(callerId: string, organizationId: string, limit = 100) {
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, events: [] as readonly UsageCostEventRow[] };
    const events = this.events
      .filter((e) => e.organizationId === organizationId)
      .sort((a, b) => b.occurredAtMs - a.occurredAtMs)
      .slice(0, limit);
    return { availability: "available" as const, events };
  }

  async listFxRates(callerId: string, limit = 30) {
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, rates: [] as readonly FxRateRow[] };
    return { availability: "available" as const, rates: [...this.fx.values()].sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, limit) };
  }

  async setFxRate(callerId: string, fecha: string, mxnPorUsd: number, fuente: string) {
    this.require(callerId);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(fecha) || fecha > new Date(this.now() + 86_400_000).toISOString().slice(0, 10)) throw new SuperadminSeguridadError("fecha invalida (no puede ser futura)", "invalid");
    if (!(mxnPorUsd > 0 && mxnPorUsd < 1000)) throw new SuperadminSeguridadError("mxn_por_usd debe estar entre 0 (exclusivo) y 1000", "invalid");
    if (fuente.trim().length < 3 || fuente.length > 200) throw new SuperadminSeguridadError("fuente obligatoria (3-200 caracteres)", "invalid");
    this.fx.set(fecha, { fecha, mxnPorUsd: Math.round(mxnPorUsd * 10_000) / 10_000, fuente: fuente.trim() });
    this.log("fx_set", callerId, null, null);
    return { availability: "available" as const };
  }

  async listPlans(callerId: string) {
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, plans: [] as readonly PlanRow[] };
    const plans = [...this.plans.values()]
      .sort((a, b) => `${a.vertical}${a.id}`.localeCompare(`${b.vertical}${b.id}`))
      .map(
        (p): PlanRow => ({
          ...p,
          limites: [...this.limits.entries()].filter(([k]) => k.startsWith(`${p.id}|`)).map(([, l]) => l).sort((a, b) => a.metrica.localeCompare(b.metrica)),
          organizaciones: [...this.orgPlan.values()].filter((x) => x === p.id).length,
        }),
      );
    return { availability: "available" as const, plans };
  }

  async upsertPlan(callerId: string, plan: UpsertPlanInput) {
    this.require(callerId);
    if (!PLAN_ID_RE.test(plan.id)) throw new SuperadminSeguridadError("id invalido (minusculas, digitos y guiones, 3-60)", "invalid");
    if (plan.nombre.trim().length < 2 || plan.nombre.length > 80) throw new SuperadminSeguridadError("nombre invalido (2-80 caracteres)", "invalid");
    if (!VERTICALES_COSTOS.includes(plan.vertical as VerticalCostos)) throw new SuperadminSeguridadError("vertical invalida", "invalid");
    if ((plan.precioBaseCentavos ?? 0) < 0 || (plan.precioAsientoCentavos ?? 0) < 0 || plan.asientosIncluidos < 0) throw new SuperadminSeguridadError("precios y asientos incluidos no pueden ser negativos", "invalid");
    const actual = this.plans.get(plan.id);
    if (actual && actual.vertical !== plan.vertical && [...this.orgPlan.values()].includes(plan.id)) {
      throw new SuperadminSeguridadError("no se puede cambiar la vertical de un plan con organizaciones asignadas", "conflict");
    }
    this.plans.set(plan.id, { ...plan, nombre: plan.nombre.trim(), updatedAtMs: this.now() });
    this.log("plan_upserted", callerId, null, plan.id);
    return { availability: "available" as const };
  }

  async setPlanLimit(callerId: string, planId: string, metrica: MetricaLimiteRow, limite: number, accion: AccionLimiteRow) {
    this.require(callerId);
    if (!this.plans.has(planId)) throw new SuperadminSeguridadError("el plan no existe", "not_found");
    if (!METRICAS_LIMITE.includes(metrica)) throw new SuperadminSeguridadError("metrica invalida", "invalid");
    if (!(limite >= 0)) throw new SuperadminSeguridadError("limite debe ser >= 0", "invalid");
    if (!ACCIONES_LIMITE.includes(accion)) throw new SuperadminSeguridadError("accion invalida", "invalid");
    if (metrica === "llm_costo_micro_usd_mes" && accion === "pausar" && limite === 0) throw new SuperadminSeguridadError("un limite LLM con accion pausar debe ser > 0", "invalid");
    this.limits.set(`${planId}|${metrica}`, { metrica, limite, accion });
    this.log("plan_limit_set", callerId, null, planId);
    return { availability: "available" as const };
  }

  async deletePlanLimit(callerId: string, planId: string, metrica: MetricaLimiteRow) {
    this.require(callerId);
    if (!this.limits.delete(`${planId}|${metrica}`)) throw new SuperadminSeguridadError("el limite no existe", "not_found");
    this.log("plan_limit_deleted", callerId, null, planId);
    return { availability: "available" as const };
  }

  private expireDue(organizationId: string): void {
    this.assignments.forEach((a, i) => {
      if (a.organizationId === organizationId && a.estado === "pending" && a.venceEnMs <= this.now()) {
        this.assignments[i] = { ...a, estado: "expired" };
        this.log("assignment_expired", null, organizationId, a.planId);
      }
    });
  }

  async requestAssignment(callerId: string, organizationId: string, planId: string, motivo: string) {
    this.require(callerId);
    const m = motivo.trim();
    if (m.length < 20) throw new SuperadminSeguridadError("motivo obligatorio (minimo 20 caracteres)", "invalid");
    const org = this.orgs.get(organizationId);
    if (!org) throw new SuperadminSeguridadError("la organizacion no existe", "not_found");
    const plan = this.plans.get(planId);
    if (!plan) throw new SuperadminSeguridadError("el plan no existe", "not_found");
    if (!plan.activo) throw new SuperadminSeguridadError("el plan esta inactivo", "conflict");
    if (plan.vertical !== org.vertical) throw new SuperadminSeguridadError(`el plan es de otra vertical (${plan.vertical} vs ${org.vertical})`, "invalid");
    if (org.status === "suspended") throw new SuperadminSeguridadError("reactiva la organizacion antes de cambiar su plan", "conflict");
    if (this.orgPlan.get(organizationId) === planId) throw new SuperadminSeguridadError("la organizacion ya tiene ese plan", "conflict");
    this.expireDue(organizationId);
    if (this.assignments.some((a) => a.organizationId === organizationId && a.estado === "pending")) throw new SuperadminSeguridadError("ya hay una solicitud pendiente para esta organizacion", "conflict");
    this.idSeq += 1;
    const row: PlanAssignmentRow = {
      id: randomUUID(),
      organizationId,
      organizationName: org.name,
      planId,
      motivo: m,
      estado: "pending",
      creadoPor: callerId,
      creadoEnMs: this.now(),
      venceEnMs: this.now() + ASSIGNMENT_TTL_MS,
      confirmadoPor: null,
      confirmadoEnMs: null,
      resultado: null,
    };
    this.assignments.push(row);
    this.log("assignment_requested", callerId, organizationId, planId);
    return { availability: "available" as const, assignment: row };
  }

  private find(id: string): number {
    const i = this.assignments.findIndex((a) => a.id === id);
    if (i < 0) throw new SuperadminSeguridadError("la solicitud no existe", "not_found");
    return i;
  }

  async confirmAssignment(callerId: string, requestId: string) {
    this.require(callerId);
    const i = this.find(requestId);
    const a = this.assignments[i]!;
    if (a.creadoPor !== callerId) throw new SuperadminSeguridadError("solo quien solicito la accion puede confirmarla", "forbidden");
    if (a.estado !== "pending") throw new SuperadminSeguridadError(`la solicitud ya no esta pendiente (estado ${a.estado})`, "conflict");
    if (a.venceEnMs <= this.now()) {
      const expired = { ...a, estado: "expired" as const };
      this.assignments[i] = expired;
      this.log("assignment_expired", callerId, a.organizationId, a.planId);
      return { availability: "available" as const, assignment: expired };
    }
    const org = this.orgs.get(a.organizationId);
    if (!org) throw new SuperadminSeguridadError("la organizacion ya no existe", "not_found");
    if (org.status === "suspended") throw new SuperadminSeguridadError("la organizacion esta suspendida", "conflict");
    const plan = this.plans.get(a.planId);
    if (!plan || !plan.activo || plan.vertical !== org.vertical) throw new SuperadminSeguridadError("el plan ya no es asignable a esta organizacion", "conflict");
    const previo = this.orgPlan.get(a.organizationId) ?? null;
    this.orgPlan.set(a.organizationId, a.planId);
    const llm = this.limits.get(`${a.planId}|llm_costo_micro_usd_mes`);
    const llmAplicado = llm && llm.accion === "pausar" && llm.limite > 0 ? llm.limite : null;
    if (llmAplicado !== null) org.llmCapMicroUsd = llmAplicado;
    const resultado = { plan_previo: previo, plan: a.planId, llm_tope_aplicado_micro_usd: llmAplicado };
    const executed: PlanAssignmentRow = { ...a, estado: "executed", confirmadoPor: callerId, confirmadoEnMs: this.now(), resultado };
    this.assignments[i] = executed;
    this.log("assignment_executed", callerId, a.organizationId, a.planId);
    return { availability: "available" as const, assignment: executed };
  }

  async cancelAssignment(callerId: string, requestId: string) {
    this.require(callerId);
    const i = this.find(requestId);
    const a = this.assignments[i]!;
    if (a.creadoPor !== callerId) throw new SuperadminSeguridadError("solo quien solicito la accion puede cancelarla", "forbidden");
    if (a.estado !== "pending") throw new SuperadminSeguridadError(`la solicitud ya no esta pendiente (estado ${a.estado})`, "conflict");
    const cancelled = { ...a, estado: "cancelled" as const };
    this.assignments[i] = cancelled;
    this.log("assignment_cancelled", callerId, a.organizationId, a.planId);
    return { availability: "available" as const, assignment: cancelled };
  }

  async listAssignments(callerId: string, limit = 50) {
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, assignments: [] as readonly PlanAssignmentRow[] };
    const rows = this.assignments
      .slice()
      .reverse()
      .slice(0, limit)
      .map((a) => (a.estado === "pending" && a.venceEnMs <= this.now() ? { ...a, estado: "expired" as const } : a));
    return { availability: "available" as const, assignments: rows };
  }
}
