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
  /** 0081: alta por sucursal (una vez). */
  readonly cuotaAltaPorSucursalCentavos: number | null;
  readonly tasaIvaBp: number;
  readonly organizacionExclusivaId: string | null;
  /** 0081: tabulador por sucursal (escalon por volumen). Vacio = rige `precioSucursalCentavos`. */
  readonly tramosSucursal: readonly TramoSucursalRow[];
  /** 0082: bandas de volumen (precio graduado + costo por banda). */
  readonly bandasUso: readonly BandaUsoRow[];
  /** 0082: margen bruto minimo del plan. */
  readonly margenMinimoPct: number | null;
}

export interface BandaUsoRow {
  readonly metrica: "minuto_voz" | "conversacion_wa";
  readonly desde: number;
  readonly hasta: number | null;
  readonly precioCentavos: number | null;
  readonly costoUnitarioMxn: number;
}

export interface TramoSucursalRow {
  readonly desde: number;
  readonly hasta: number | null;
  readonly precioCentavos: number | null;
  /** Bolsa por sucursal propia del tramo; null = la del plan. */
  readonly minutosVozIncluidosPorSucursal: number | null;
  readonly conversacionesWaIncluidasPorSucursal: number | null;
}

/** Claves que acepta `core.superadmin_set_plan_tarifa` (ausente = conservar). */
export type TarifaPlanInput = Partial<Omit<TarifaPlanRow, "planId" | "nombre" | "vertical" | "activo" | "cuotaFijaCentavos" | "cuotaAltaPorSucursalCentavos" | "tramosSucursal" | "bandasUso" | "margenMinimoPct">>;

export interface DiaConsumoRow {
  readonly dia: string;
  readonly segundosVoz: number;
  readonly llamadas: number;
  readonly conversacionesWa: number;
}

export interface SucursalConsumoRow {
  readonly propertyId: string;
  readonly nombre: string;
  readonly activa: boolean;
  readonly llamadas: number;
  readonly minutosVoz: number;
  readonly duracionPromedioS: number | null;
  readonly pedidosAgentes: number;
}

export interface MesHistorialRow {
  readonly mes: string;
  readonly llamadas: number;
  readonly minutosVoz: number;
  readonly conversacionesWa: number;
}

/** restaurantes.consumo_detalle_mes (201). */
export interface ConsumoDetalleRow {
  readonly organizationId: string;
  readonly mes: string;
  readonly zonaHoraria: string;
  readonly totales: {
    readonly llamadas: number;
    readonly segundosVoz: number;
    readonly minutosVoz: number;
    readonly duracionPromedioS: number | null;
    readonly conversacionesWa: number;
    readonly pedidosAgentes: number;
  };
  readonly dias: readonly DiaConsumoRow[];
  readonly sucursales: readonly SucursalConsumoRow[];
  readonly historial: readonly MesHistorialRow[];
}

export type ClaveCostoUnitario =
  | "minuto_voz"
  | "conversacion_wa"
  | "fijo_mensual_sucursal"
  | "numero_voz_mensual_sucursal"
  | "fijo_mensual_organizacion"
  | "comision_tarjeta_pct"
  | "comision_tarjeta_fijo_mxn";
export const CLAVES_COSTO_UNITARIO: readonly ClaveCostoUnitario[] = [
  "minuto_voz",
  "conversacion_wa",
  "fijo_mensual_sucursal",
  "numero_voz_mensual_sucursal",
  "fijo_mensual_organizacion",
  "comision_tarjeta_pct",
  "comision_tarjeta_fijo_mxn",
];

export interface CostoUnitarioRow {
  readonly clave: ClaveCostoUnitario;
  readonly costoMxn: number;
  readonly fuente: string;
  readonly actualizadoEnMs: number;
}

export interface OrganizacionMedidaRow {
  readonly organizationId: string;
  readonly nombre: string;
  readonly slug: string;
  readonly vertical: string;
  readonly zonaHoraria: string;
  readonly sucursalesActivas: number;
  readonly tarifa: TarifaPlanRow;
}

export type MetricaBolsa = "minutos_voz" | "conversaciones_wa";

export interface CotizacionRow {
  readonly id: string;
  readonly folio: number;
  readonly organizationId: string;
  readonly planId: string;
  readonly detalle: Record<string, unknown>;
  readonly margenPct: number;
  readonly margenMinimoPct: number;
  readonly motivoExcepcion: string | null;
  readonly creadoPor: string;
  readonly creadoEn: string;
}

export interface RegistrarCotizacionInput {
  readonly organizationId: string;
  readonly planId: string;
  readonly detalle: Record<string, unknown>;
  readonly margenPct: number;
  readonly margenMinimoPct: number;
  readonly motivoExcepcion: string | null;
}

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
  /** 0081. Reemplaza el tabulador completo (arreglo vacio = quitarlo). */
  setTramos(callerId: string, planId: string, tramos: readonly TramoSucursalRow[]): Promise<{ availability: CobroAvailability; tarifa: TarifaPlanRow | null }>;
  setCuotaAltaPorSucursal(callerId: string, planId: string, centavos: number | null): Promise<{ availability: CobroAvailability }>;
  /** 0082. Reemplaza las bandas de una metrica ([] = quitarlas). */
  setBandas(callerId: string, planId: string, metrica: BandaUsoRow["metrica"], bandas: readonly Omit<BandaUsoRow, "metrica">[]): Promise<{ availability: CobroAvailability }>;
  setMargenMinimo(callerId: string, planId: string, margenPct: number | null): Promise<{ availability: CobroAvailability }>;
  /** 201. `callerId = null` = sistema. `detalle: null` = sin acceso. */
  consumoDetalleRestaurantes(callerId: string | null, organizationId: string, mes: string, mesesHistorial: number): Promise<{ availability: CobroAvailability; detalle: ConsumoDetalleRow | null }>;
  costosUnitarios(callerId: string): Promise<{ availability: CobroAvailability; costos: readonly CostoUnitarioRow[] }>;
  setCostoUnitario(callerId: string, clave: ClaveCostoUnitario, costoMxn: number, fuente: string): Promise<{ availability: CobroAvailability }>;
  /** `callerId = null` = sistema (cron de avisos de bolsa). */
  organizacionesMedidas(callerId: string | null): Promise<{ availability: CobroAvailability; organizaciones: readonly OrganizacionMedidaRow[] }>;
  /** SOLO sistema. true = este llamador emite el aviso. */
  reclamarAvisoBolsa(organizationId: string, periodo: string, metrica: MetricaBolsa, umbral: 80 | 100 | 150): Promise<{ availability: CobroAvailability; reclamado: boolean }>;
  /** 0082. Superadmin: registra la cotizacion convertida en plan (append-only). */
  registrarCotizacion(callerId: string, input: RegistrarCotizacionInput): Promise<{ availability: CobroAvailability; cotizacion: { id: string; folio: number } | null }>;
  listarCotizaciones(callerId: string, organizationId: string | null, limit?: number): Promise<{ availability: CobroAvailability; cotizaciones: readonly CotizacionRow[] }>;
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
    cuotaAltaPorSucursalCentavos: numOrNull(raw.cuotaAltaPorSucursalCentavos),
    tasaIvaBp: numOr(raw.tasaIvaBp, 1600),
    organizacionExclusivaId: typeof raw.organizacionExclusivaId === "string" ? raw.organizacionExclusivaId : null,
    margenMinimoPct: numOrNull(raw.margenMinimoPct),
    bandasUso: Array.isArray(raw.bandasUso)
      ? (raw.bandasUso as Array<Record<string, unknown>>).map((b) => ({
          metrica: b.metrica === "conversacion_wa" ? ("conversacion_wa" as const) : ("minuto_voz" as const),
          desde: numOr(b.desde, 0),
          hasta: numOrNull(b.hasta),
          precioCentavos: numOrNull(b.precioCentavos),
          costoUnitarioMxn: numOr(b.costoUnitarioMxn, 0),
        }))
      : [],
    tramosSucursal: Array.isArray(raw.tramosSucursal)
      ? (raw.tramosSucursal as Array<Record<string, unknown>>).map((t) => ({
          desde: numOr(t.desde, 1),
          hasta: numOrNull(t.hasta),
          precioCentavos: numOrNull(t.precioCentavos),
          minutosVozIncluidosPorSucursal: numOrNull(t.minutosVozIncluidosPorSucursal),
          conversacionesWaIncluidasPorSucursal: numOrNull(t.conversacionesWaIncluidasPorSucursal),
        }))
      : [],
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
  setTramos(callerId: string, planId: string, tramos: readonly TramoSucursalRow[]) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ t: Record<string, unknown> | null }>(`select core.superadmin_set_plan_tramos($1, $2, $3::jsonb) as t;`, [callerId, planId, JSON.stringify(tramos)]);
        const t = rows[0]?.t ?? null;
        return { availability: "available" as const, tarifa: t ? mapTarifaPlan(t) : null };
      },
      () => ({ availability: "not_migrated" as const, tarifa: null }),
    );
  }

  setCuotaAltaPorSucursal(callerId: string, planId: string, centavos: number | null) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_set_plan_cuota_alta_sucursal($1, $2, $3);`, [callerId, planId, centavos]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  setBandas(callerId: string, planId: string, metrica: BandaUsoRow["metrica"], bandas: readonly Omit<BandaUsoRow, "metrica">[]) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_set_plan_bandas($1, $2, $3, $4::jsonb);`, [callerId, planId, metrica, JSON.stringify(bandas)]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  setMargenMinimo(callerId: string, planId: string, margenPct: number | null) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_set_plan_margen_minimo($1, $2, $3);`, [callerId, planId, margenPct]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  consumoDetalleRestaurantes(callerId: string | null, organizationId: string, mes: string, mesesHistorial: number) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ d: Record<string, unknown> | null }>(`select restaurantes.consumo_detalle_mes($1, $2, $3::date, $4) as d;`, [callerId, organizationId, mes, mesesHistorial]);
        const d = rows[0]?.d ?? null;
        return { availability: "available" as const, detalle: d ? mapConsumoDetalle(d) : null };
      },
      () => ({ availability: "not_migrated" as const, detalle: null }),
    );
  }

  costosUnitarios(callerId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ clave: ClaveCostoUnitario; costo_mxn: string; fuente: string; updated_at: Date | string }>(
          `select clave, costo_mxn, fuente, updated_at from core.cobro_costos_unitarios($1);`,
          [callerId],
        );
        return {
          availability: "available" as const,
          costos: rows.map((r) => ({ clave: r.clave, costoMxn: Number(r.costo_mxn), fuente: r.fuente, actualizadoEnMs: new Date(r.updated_at).getTime() })),
        };
      },
      () => ({ availability: "not_migrated" as const, costos: [] as CostoUnitarioRow[] }),
    );
  }

  setCostoUnitario(callerId: string, clave: ClaveCostoUnitario, costoMxn: number, fuente: string) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_set_cobro_costo_unitario($1, $2, $3, $4);`, [callerId, clave, costoMxn, fuente]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  organizacionesMedidas(callerId: string | null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ organization_id: string; nombre: string; slug: string; vertical: string; zona_horaria: string; sucursales_activas: number; tarifa: Record<string, unknown> }>(
          `select organization_id, nombre, slug, vertical, zona_horaria, sucursales_activas, tarifa from core.superadmin_cobro_organizaciones($1);`,
          [callerId],
        );
        return {
          availability: "available" as const,
          organizaciones: rows.map((r) => ({
            organizationId: r.organization_id,
            nombre: r.nombre,
            slug: r.slug,
            vertical: r.vertical,
            zonaHoraria: r.zona_horaria,
            sucursalesActivas: Number(r.sucursales_activas),
            tarifa: mapTarifaPlan(r.tarifa),
          })),
        };
      },
      () => ({ availability: "not_migrated" as const, organizaciones: [] as OrganizacionMedidaRow[] }),
    );
  }

  reclamarAvisoBolsa(organizationId: string, periodo: string, metrica: MetricaBolsa, umbral: 80 | 100 | 150) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ ok: boolean }>(`select core.cobro_reclamar_aviso_bolsa($1, $2::date, $3, $4) as ok;`, [organizationId, periodo, metrica, umbral]);
        return { availability: "available" as const, reclamado: rows[0]?.ok === true };
      },
      () => ({ availability: "not_migrated" as const, reclamado: false }),
    );
  }
  registrarCotizacion(callerId: string, input: RegistrarCotizacionInput) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ r: { id: string; folio: number | string } | null }>(
          `select core.superadmin_registrar_cotizacion($1, $2, $3, $4::jsonb, $5, $6, $7) as r;`,
          [callerId, input.organizationId, input.planId, JSON.stringify(input.detalle), input.margenPct, input.margenMinimoPct, input.motivoExcepcion],
        );
        const r = rows[0]?.r ?? null;
        return { availability: "available" as const, cotizacion: r ? { id: r.id, folio: Number(r.folio) } : null };
      },
      () => ({ availability: "not_migrated" as const, cotizacion: null }),
    );
  }

  listarCotizaciones(callerId: string, organizationId: string | null, limit = 50) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ c: Record<string, unknown> }>(`select c from core.superadmin_listar_cotizaciones($1, $2, $3) c;`, [callerId, organizationId, limit]);
        return { availability: "available" as const, cotizaciones: rows.map((r) => mapCotizacion(r.c)) };
      },
      () => ({ availability: "not_migrated" as const, cotizaciones: [] as CotizacionRow[] }),
    );
  }
}

export function mapCotizacion(c: Record<string, unknown>): CotizacionRow {
  return {
    id: String(c.id),
    folio: Number(c.folio),
    organizationId: String(c.organizationId),
    planId: String(c.planId),
    detalle: (c.detalle && typeof c.detalle === "object" ? c.detalle : {}) as Record<string, unknown>,
    margenPct: Number(c.margenPct),
    margenMinimoPct: Number(c.margenMinimoPct),
    motivoExcepcion: typeof c.motivoExcepcion === "string" ? c.motivoExcepcion : null,
    creadoPor: String(c.creadoPor),
    creadoEn: String(c.creadoEn),
  };
}

export function mapConsumoDetalle(d: Record<string, unknown>): ConsumoDetalleRow {
  const t = (d.totales ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
  return {
    organizationId: String(d.organizationId),
    mes: String(d.mes),
    zonaHoraria: String(d.zonaHoraria),
    totales: {
      llamadas: numOr(t.llamadas, 0),
      segundosVoz: numOr(t.segundosVoz, 0),
      minutosVoz: numOr(t.minutosVoz, 0),
      duracionPromedioS: numOrNull(t.duracionPromedioS),
      conversacionesWa: numOr(t.conversacionesWa, 0),
      pedidosAgentes: numOr(t.pedidosAgentes, 0),
    },
    dias: arr(d.dias).map((x) => ({ dia: String(x.dia), segundosVoz: numOr(x.segundosVoz, 0), llamadas: numOr(x.llamadas, 0), conversacionesWa: numOr(x.conversacionesWa, 0) })),
    sucursales: arr(d.sucursales).map((x) => ({
      propertyId: String(x.propertyId),
      nombre: String(x.nombre),
      activa: x.activa === true,
      llamadas: numOr(x.llamadas, 0),
      minutosVoz: numOr(x.minutosVoz, 0),
      duracionPromedioS: numOrNull(x.duracionPromedioS),
      pedidosAgentes: numOr(x.pedidosAgentes, 0),
    })),
    historial: arr(d.historial).map((x) => ({ mes: String(x.mes), llamadas: numOr(x.llamadas, 0), minutosVoz: numOr(x.minutosVoz, 0), conversacionesWa: numOr(x.conversacionesWa, 0) })),
  };
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

  consumos = new Map<string, ConsumoDetalleRow>();
  costos = new Map<ClaveCostoUnitario, CostoUnitarioRow>();
  avisosReclamados = new Set<string>();

  async setTramos(callerId: string, planId: string, tramos: readonly TramoSucursalRow[]) {
    if (this.availability === "not_migrated") return { availability: this.availability, tarifa: null };
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo superadmin", "forbidden");
    const actual = this.tarifas.get(planId);
    if (!actual) throw new SuperadminSeguridadError("el plan no existe", "not_found");
    const nueva: TarifaPlanRow = { ...actual, tramosSucursal: [...tramos] };
    this.tarifas.set(planId, nueva);
    return { availability: this.availability, tarifa: nueva };
  }

  async setCuotaAltaPorSucursal(callerId: string, planId: string, centavos: number | null) {
    if (this.availability === "not_migrated") return { availability: this.availability };
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo superadmin", "forbidden");
    const actual = this.tarifas.get(planId);
    if (!actual) throw new SuperadminSeguridadError("el plan no existe", "not_found");
    this.tarifas.set(planId, { ...actual, cuotaAltaPorSucursalCentavos: centavos });
    return { availability: this.availability };
  }

  async consumoDetalleRestaurantes(callerId: string | null, organizationId: string, _mes: string, _meses: number) {
    if (this.availability === "not_migrated") return { availability: this.availability, detalle: null };
    if (!this.puedeVer(callerId, organizationId)) return { availability: this.availability, detalle: null };
    return { availability: this.availability, detalle: this.consumos.get(organizationId) ?? null };
  }

  async costosUnitarios(callerId: string) {
    if (this.availability === "not_migrated") return { availability: this.availability, costos: [] };
    return { availability: this.availability, costos: this.superadmins.has(callerId) ? [...this.costos.values()] : [] };
  }

  async setCostoUnitario(callerId: string, clave: ClaveCostoUnitario, costoMxn: number, fuente: string) {
    if (this.availability === "not_migrated") return { availability: this.availability };
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo superadmin", "forbidden");
    this.costos.set(clave, { clave, costoMxn, fuente, actualizadoEnMs: Date.now() });
    return { availability: this.availability };
  }

  async organizacionesMedidas(callerId: string | null) {
    if (this.availability === "not_migrated") return { availability: this.availability, organizaciones: [] };
    if (callerId !== null && !this.superadmins.has(callerId)) return { availability: this.availability, organizaciones: [] };
    const organizaciones: OrganizacionMedidaRow[] = [];
    for (const o of this.organizaciones.values()) {
      if (o.plan?.modeloCobro === "medido") {
        organizaciones.push({ organizationId: o.organizationId, nombre: o.organizationId, slug: o.organizationId.slice(0, 8), vertical: o.vertical, zonaHoraria: o.zonaHoraria, sucursalesActivas: o.sucursalesActivas, tarifa: o.plan });
      }
    }
    return { availability: this.availability, organizaciones };
  }

  async reclamarAvisoBolsa(organizationId: string, periodo: string, metrica: MetricaBolsa, umbral: 80 | 100 | 150) {
    if (this.availability === "not_migrated") return { availability: this.availability, reclamado: false };
    const clave = `${organizationId}:${periodo.slice(0, 7)}:${metrica}:${umbral}`;
    if (this.avisosReclamados.has(clave)) return { availability: this.availability, reclamado: false };
    this.avisosReclamados.add(clave);
    return { availability: this.availability, reclamado: true };
  }

  cotizaciones: CotizacionRow[] = [];

  async registrarCotizacion(callerId: string, input: RegistrarCotizacionInput) {
    if (this.availability === "not_migrated") return { availability: this.availability, cotizacion: null };
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo superadmin", "forbidden");
    if (input.margenPct < input.margenMinimoPct && (input.motivoExcepcion ?? "").trim().length < 20) throw new SuperadminSeguridadError("margen bajo el minimo sin motivo", "invalid");
    const fila: CotizacionRow = { id: `cot-${this.cotizaciones.length + 1}`, folio: this.cotizaciones.length + 1, ...input, creadoPor: callerId, creadoEn: new Date().toISOString() };
    this.cotizaciones.push(fila);
    return { availability: this.availability, cotizacion: { id: fila.id, folio: fila.folio } };
  }

  async listarCotizaciones(callerId: string, organizationId: string | null) {
    if (this.availability === "not_migrated") return { availability: this.availability, cotizaciones: [] };
    if (!this.superadmins.has(callerId)) return { availability: this.availability, cotizaciones: [] };
    return { availability: this.availability, cotizaciones: this.cotizaciones.filter((c) => organizationId === null || c.organizationId === organizationId) };
  }

  async setBandas(callerId: string, planId: string, metrica: BandaUsoRow["metrica"], bandas: readonly Omit<BandaUsoRow, "metrica">[]) {
    if (this.availability === "not_migrated") return { availability: this.availability };
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo superadmin", "forbidden");
    const actual = this.tarifas.get(planId);
    if (!actual) throw new SuperadminSeguridadError("el plan no existe", "not_found");
    this.tarifas.set(planId, { ...actual, bandasUso: [...actual.bandasUso.filter((b) => b.metrica !== metrica), ...bandas.map((b) => ({ ...b, metrica }))] });
    return { availability: this.availability };
  }

  async setMargenMinimo(callerId: string, planId: string, margenPct: number | null) {
    if (this.availability === "not_migrated") return { availability: this.availability };
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo superadmin", "forbidden");
    const actual = this.tarifas.get(planId);
    if (!actual) throw new SuperadminSeguridadError("el plan no existe", "not_found");
    this.tarifas.set(planId, { ...actual, margenMinimoPct: margenPct });
    return { availability: this.availability };
  }
}
