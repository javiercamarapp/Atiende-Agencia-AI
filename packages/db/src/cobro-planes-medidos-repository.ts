// Repositorio del cobro por plan MEDIDO -- puerto contra las funciones `security definer` de
// packages/db/migrations/0080_cobro_planes_medidos.sql (tarifa del plan) y
// packages/domain-restaurantes/migrations/200_uso_facturable.sql (uso del mes).
//
// SESIONES: `tarifaDeOrganizacion` y `usoFacturableRestaurantes` aceptan `callerId = null` para la sesion de SISTEMA
// (`withAppSession({ userId: null })`, el webhook de cobro); con usuario son caller-bound. Las de superadmin siempre
// son caller-bound. Estas clases no eligen la sesion: reciben el `TenantDbSession` ya abierto.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada metodo corre bajo `runWithSavepointFallback`; un SQLSTATE
// 42883/42P01/42703 (0080/200 sin aplicar) devuelve `availability: "not_migrated"` sin datos -- nunca 500 ni exito
// simulado. Los errores de negocio de la base (42501/22023/P0002/55006/23514) se traducen a `SuperadminSeguridadError`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { SuperadminSeguridadError } from "./superadmin-seguridad-repository.ts";

export type CobroAvailability = "available" | "not_migrated";

/** Forma de `core.plan_tarifa_json` (claves camelCase). Los bigint pueden llegar como texto: se normalizan a number. */
export interface TarifaPlanRow {
  readonly planId: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly activo: boolean;
  readonly modeloCobro: "por_asiento" | "medido";
  readonly cuotaFijaCentavos: number | null;
  readonly precioSucursalCentavos: number | null;
  readonly sucursalesIncluidas: number;
  readonly minutosVozIncluidos: number;
  readonly minutosVozIncluidosPorSucursal: number;
  readonly precioMinutoVozExcedenteCentavos: number | null;
  readonly conversacionesWaIncluidas: number;
  readonly conversacionesWaIncluidasPorSucursal: number;
  readonly precioConversacionWaExcedenteCentavos: number | null;
  readonly usoJustoPct: number | null;
  readonly cuotaAltaCentavos: number | null;
  readonly tasaIvaBp: number;
  readonly organizacionExclusivaId: string | null;
}

/** Claves que acepta `core.superadmin_set_plan_tarifa` (ausente = conservar). */
export type TarifaPlanInput = Partial<Omit<TarifaPlanRow, "planId" | "nombre" | "vertical" | "activo" | "cuotaFijaCentavos">>;

export interface TarifaOrganizacionRow {
  readonly organizationId: string;
  readonly vertical: string;
  readonly zonaHoraria: string;
  readonly sucursalesActivas: number;
  readonly plan: TarifaPlanRow | null;
}

export interface UsoFacturableRow {
  readonly organizationId: string;
  /** Primer dia del mes, `YYYY-MM-DD`. */
  readonly mes: string;
  readonly zonaHoraria: string;
  readonly desde: string;
  readonly hasta: string;
  readonly segundosVoz: number;
  readonly minutosVoz: number;
  readonly llamadas: number;
  readonly conversacionesWa: number;
}

export interface CobroPlanesRepository {
  listTarifas(callerId: string): Promise<{ availability: CobroAvailability; tarifas: readonly TarifaPlanRow[] }>;
  setTarifa(callerId: string, planId: string, tarifa: TarifaPlanInput): Promise<{ availability: CobroAvailability; tarifa: TarifaPlanRow | null }>;
  /** `callerId = null` = sesion de sistema. `tarifa: null` = sin acceso o la organizacion no existe. */
  tarifaDeOrganizacion(callerId: string | null, organizationId: string): Promise<{ availability: CobroAvailability; tarifa: TarifaOrganizacionRow | null }>;
  /** `mes` = `YYYY-MM-DD` (cualquier dia del mes). `uso: null` = sin acceso o la organizacion no existe. */
  usoFacturableRestaurantes(callerId: string | null, organizationId: string, mes: string): Promise<{ availability: CobroAvailability; uso: UsoFacturableRow | null }>;
}

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
async function guarded<TOk, TMissing>(db: TenantDbSession, run: () => Promise<TOk>, onMissing: () => TMissing): Promise<TOk | TMissing> {
  try {
    return await runWithSavepointFallback<TOk | TMissing>({
      session: db,
      primary: run,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        if (!warned) {
          warned = true;
          console.warn("cobro-planes-medidos-repository: faltan 0080_cobro_planes_medidos y/o restaurantes 200_uso_facturable -- degradando a 'no disponible aun'.");
        }
        return onMissing();
      },
    });
  } catch (err) {
    throw toTypedError(err) ?? err;
  }
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const numOr = (v: unknown, d: number): number => (v === null || v === undefined ? d : Number(v));

export function mapTarifaPlan(raw: Record<string, unknown>): TarifaPlanRow {
  return {
    planId: String(raw.planId),
    nombre: String(raw.nombre),
    vertical: String(raw.vertical),
    activo: raw.activo === true,
    modeloCobro: raw.modeloCobro === "medido" ? "medido" : "por_asiento",
    cuotaFijaCentavos: numOrNull(raw.cuotaFijaCentavos),
    precioSucursalCentavos: numOrNull(raw.precioSucursalCentavos),
    sucursalesIncluidas: numOr(raw.sucursalesIncluidas, 0),
    minutosVozIncluidos: numOr(raw.minutosVozIncluidos, 0),
    minutosVozIncluidosPorSucursal: numOr(raw.minutosVozIncluidosPorSucursal, 0),
    precioMinutoVozExcedenteCentavos: numOrNull(raw.precioMinutoVozExcedenteCentavos),
    conversacionesWaIncluidas: numOr(raw.conversacionesWaIncluidas, 0),
    conversacionesWaIncluidasPorSucursal: numOr(raw.conversacionesWaIncluidasPorSucursal, 0),
    precioConversacionWaExcedenteCentavos: numOrNull(raw.precioConversacionWaExcedenteCentavos),
    usoJustoPct: numOrNull(raw.usoJustoPct),
    cuotaAltaCentavos: numOrNull(raw.cuotaAltaCentavos),
    tasaIvaBp: numOr(raw.tasaIvaBp, 1600),
    organizacionExclusivaId: typeof raw.organizacionExclusivaId === "string" ? raw.organizacionExclusivaId : null,
  };
}

export class PostgresCobroPlanesRepository implements CobroPlanesRepository {
  constructor(private readonly db: TenantDbSession) {}

  listTarifas(callerId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ t: Record<string, unknown> }>(`select t from core.list_plan_tarifas_for_superadmin($1) t;`, [callerId]);
        return { availability: "available" as const, tarifas: rows.map((r) => mapTarifaPlan(r.t)) };
      },
      () => ({ availability: "not_migrated" as const, tarifas: [] as TarifaPlanRow[] }),
    );
  }

  setTarifa(callerId: string, planId: string, tarifa: TarifaPlanInput) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ t: Record<string, unknown> | null }>(`select core.superadmin_set_plan_tarifa($1, $2, $3::jsonb) as t;`, [callerId, planId, JSON.stringify(tarifa)]);
        const t = rows[0]?.t ?? null;
        return { availability: "available" as const, tarifa: t ? mapTarifaPlan(t) : null };
      },
      () => ({ availability: "not_migrated" as const, tarifa: null }),
    );
  }

  tarifaDeOrganizacion(callerId: string | null, organizationId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ t: Record<string, unknown> | null }>(`select core.plan_tarifa_for_org($1, $2) as t;`, [callerId, organizationId]);
        const t = rows[0]?.t ?? null;
        if (!t) return { availability: "available" as const, tarifa: null };
        const plan = t.plan && typeof t.plan === "object" ? mapTarifaPlan(t.plan as Record<string, unknown>) : null;
        return {
          availability: "available" as const,
          tarifa: {
            organizationId: String(t.organizationId),
            vertical: String(t.vertical),
            zonaHoraria: String(t.zonaHoraria),
            sucursalesActivas: numOr(t.sucursalesActivas, 0),
            plan,
          },
        };
      },
      () => ({ availability: "not_migrated" as const, tarifa: null }),
    );
  }

  usoFacturableRestaurantes(callerId: string | null, organizationId: string, mes: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ u: Record<string, unknown> | null }>(`select restaurantes.uso_facturable_mes($1, $2, $3::date) as u;`, [callerId, organizationId, mes]);
        const u = rows[0]?.u ?? null;
        if (!u) return { availability: "available" as const, uso: null };
        return {
          availability: "available" as const,
          uso: {
            organizationId: String(u.organizationId),
            mes: String(u.mes),
            zonaHoraria: String(u.zonaHoraria),
            desde: String(u.desde),
            hasta: String(u.hasta),
            segundosVoz: numOr(u.segundosVoz, 0),
            minutosVoz: numOr(u.minutosVoz, 0),
            llamadas: numOr(u.llamadas, 0),
            conversacionesWa: numOr(u.conversacionesWa, 0),
          },
        };
      },
      () => ({ availability: "not_migrated" as const, uso: null }),
    );
  }
}

/** Doble para tests (no se usa en produccion). */
export class InMemoryCobroPlanesRepository implements CobroPlanesRepository {
  tarifas = new Map<string, TarifaPlanRow>();
  organizaciones = new Map<string, TarifaOrganizacionRow>();
  usos = new Map<string, UsoFacturableRow>();
  superadmins = new Set<string>();
  miembros = new Map<string, Set<string>>();
  availability: CobroAvailability = "available";

  private puedeVer(callerId: string | null, organizationId: string): boolean {
    if (callerId === null) return true;
    return this.superadmins.has(callerId) || (this.miembros.get(organizationId)?.has(callerId) ?? false);
  }

  async listTarifas(callerId: string) {
    if (this.availability === "not_migrated") return { availability: this.availability, tarifas: [] };
    return { availability: this.availability, tarifas: this.superadmins.has(callerId) ? [...this.tarifas.values()] : [] };
  }

  async setTarifa(callerId: string, planId: string, tarifa: TarifaPlanInput) {
    if (this.availability === "not_migrated") return { availability: this.availability, tarifa: null };
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo superadmin", "forbidden");
    const actual = this.tarifas.get(planId);
    if (!actual) throw new SuperadminSeguridadError("el plan no existe", "not_found");
    const nueva: TarifaPlanRow = { ...actual, ...tarifa };
    this.tarifas.set(planId, nueva);
    return { availability: this.availability, tarifa: nueva };
  }

  async tarifaDeOrganizacion(callerId: string | null, organizationId: string) {
    if (this.availability === "not_migrated") return { availability: this.availability, tarifa: null };
    if (!this.puedeVer(callerId, organizationId)) return { availability: this.availability, tarifa: null };
    return { availability: this.availability, tarifa: this.organizaciones.get(organizationId) ?? null };
  }

  async usoFacturableRestaurantes(callerId: string | null, organizationId: string, _mes: string) {
    if (this.availability === "not_migrated") return { availability: this.availability, uso: null };
    if (!this.puedeVer(callerId, organizationId)) return { availability: this.availability, uso: null };
    return { availability: this.availability, uso: this.usos.get(organizationId) ?? null };
  }
}
