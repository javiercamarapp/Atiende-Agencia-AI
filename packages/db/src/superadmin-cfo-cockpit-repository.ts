// Repositorio del CFO de la plataforma (cockpit del superadmin) -- puerto contra las funciones
// `security definer` de packages/db/migrations/0085_superadmin_cfo_cockpit.sql: supuestos de costo
// unitario y umbrales, capturas mensuales del dueño y uso por organizacion y mes.
// El ingreso, el plan y el costo por categoria NO pasan por aqui: salen de `CfoRepository` (0030/0057).
//
// SESIONES: los metodos `*ForSystem` son solo-sistema (`withAppSession({ userId: null })`, cron de
// alertas); el resto es caller-bound. Esta clase no elige la sesion.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada metodo corre bajo `runWithSavepointFallback`. Un
// SQLSTATE 42883/42P01/42703 (0085 sin aplicar) revierte SOLO el savepoint y devuelve
// `availability: "not_migrated"`; nunca un 500 ni un exito simulado. 42501/22023 se tipan como
// `SuperadminSeguridadError` (forbidden/invalid).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { SuperadminSeguridadError } from "./superadmin-seguridad-repository.ts";
import type { CostosAvailability } from "./superadmin-costos-planes-repository.ts";

export const CLAVES_SUPUESTO_CFO = [
  "voz_usd_minuto",
  "telefonia_usd_minuto",
  "llm_usd_conversacion_wa",
  "whatsapp_usd_conversacion",
  "umbral_margen_pct",
  "umbral_pool_pct",
  "umbral_pico_costo_pct",
  "umbral_fx_pct",
  "ltv_meses_tope",
] as const;
export type ClaveSupuestoCfo = (typeof CLAVES_SUPUESTO_CFO)[number];

export const TIPOS_CAPTURA_CFO = ["gasto_fijo", "marketing", "saldo_caja", "presupuesto_ingreso", "presupuesto_costo"] as const;
export type TipoCapturaCfo = (typeof TIPOS_CAPTURA_CFO)[number];

export interface SupuestoCfoRow {
  readonly clave: ClaveSupuestoCfo;
  /** `*` = cualquier proveedor. */
  readonly proveedor: string;
  readonly valor: number;
  readonly fuente: string;
  readonly nota: string | null;
  readonly updatedAt: string | null;
}

export interface CapturaCfoRow {
  /** `YYYY-MM-01`. */
  readonly mes: string;
  readonly tipo: TipoCapturaCfo;
  readonly concepto: string;
  readonly montoMxnCentavos: number;
  readonly nota: string | null;
}

export interface UsoCfoRow {
  readonly organizationId: string;
  /** `YYYY-MM-01`. */
  readonly mes: string;
  readonly vertical: string;
  readonly llmMicroUsd: number;
  readonly eventosMicroUsd: number;
  /** `null` = la organizacion no tiene medidor de llamadas (no es de restaurantes o falta la tabla). */
  readonly llamadas: number | null;
  readonly segundosVoz: number | null;
  readonly segundosPorProveedor: Readonly<Record<string, number>> | null;
  readonly pedidos: number | null;
  readonly pedidosVoz: number | null;
  readonly pedidosWhatsapp: number | null;
  /** Del medidor de cobro (`restaurantes.uso_facturable_mes`, PR #771); `null` mientras no exista. */
  readonly conversacionesWa: number | null;
  readonly minutosFacturables: number | null;
  /** Fila completa de `core.plan` vigente (incluye las columnas del plan medido si 0103 esta aplicada). */
  readonly plan: Readonly<Record<string, unknown>> | null;
}

export interface CfoCockpitRepository {
  listSupuestos(callerId: string): Promise<{ availability: CostosAvailability; supuestos: readonly SupuestoCfoRow[] }>;
  listSupuestosForSystem(): Promise<{ availability: CostosAvailability; supuestos: readonly SupuestoCfoRow[] }>;
  /** `valor = null` borra la fila (vuelve al valor medido del codigo). */
  setSupuesto(callerId: string, clave: ClaveSupuestoCfo, proveedor: string, valor: number | null, fuente: string, nota: string | null): Promise<{ availability: CostosAvailability }>;
  listCapturas(callerId: string, desde: string, hasta: string): Promise<{ availability: CostosAvailability; capturas: readonly CapturaCfoRow[] }>;
  /** `montoMxnCentavos = null` borra el concepto. */
  setCaptura(callerId: string, mes: string, tipo: TipoCapturaCfo, concepto: string, montoMxnCentavos: number | null, nota: string | null): Promise<{ availability: CostosAvailability }>;
  getUso(callerId: string, desde: string, hasta: string): Promise<{ availability: CostosAvailability; uso: readonly UsoCfoRow[] }>;
  getUsoForSystem(desde: string, hasta: string): Promise<{ availability: CostosAvailability; uso: readonly UsoCfoRow[] }>;
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-cfo-cockpit-repository: las funciones/tablas de 0085_superadmin_cfo_cockpit.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible aun' (nunca 500, nunca exito simulado).",
  );
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
    default:
      return null;
  }
}

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

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

interface SupuestoRaw {
  clave: ClaveSupuestoCfo;
  proveedor: string;
  valor: string | number;
  fuente: string;
  nota: string | null;
  updated_at: string | Date | null;
}
function mapSupuesto(r: SupuestoRaw): SupuestoCfoRow {
  return {
    clave: r.clave,
    proveedor: r.proveedor,
    valor: Number(r.valor),
    fuente: r.fuente,
    nota: r.nota,
    updatedAt: r.updated_at === null ? null : new Date(r.updated_at).toISOString(),
  };
}

interface UsoRaw {
  organization_id: string;
  mes: string;
  vertical: string;
  llm_micro_usd: string | number;
  eventos_micro_usd: string | number;
  llamadas: number | null;
  segundos_voz: string | number | null;
  segundos_por_proveedor: Record<string, string | number> | null;
  pedidos: number | null;
  pedidos_voz: number | null;
  pedidos_whatsapp: number | null;
  conversaciones_wa: number | null;
  minutos_facturables: string | number | null;
  plan: Record<string, unknown> | null;
}
function mapUso(r: UsoRaw): UsoCfoRow {
  return {
    organizationId: r.organization_id,
    mes: r.mes,
    vertical: r.vertical,
    llmMicroUsd: Number(r.llm_micro_usd),
    eventosMicroUsd: Number(r.eventos_micro_usd),
    llamadas: num(r.llamadas),
    segundosVoz: num(r.segundos_voz),
    segundosPorProveedor: r.segundos_por_proveedor === null ? null : Object.fromEntries(Object.entries(r.segundos_por_proveedor).map(([k, v]) => [k, Number(v)])),
    pedidos: num(r.pedidos),
    pedidosVoz: num(r.pedidos_voz),
    pedidosWhatsapp: num(r.pedidos_whatsapp),
    conversacionesWa: num(r.conversaciones_wa),
    minutosFacturables: num(r.minutos_facturables),
    plan: r.plan,
  };
}

// `mes::text`: el driver `pg` devuelve `date` como Date a medianoche local (corre el dia segun la zona).
const USO_COLS = `organization_id, mes::text as mes, vertical, llm_micro_usd, eventos_micro_usd, llamadas, segundos_voz, segundos_por_proveedor,
  pedidos, pedidos_voz, pedidos_whatsapp, conversaciones_wa, minutos_facturables, plan`;
const SUPUESTO_COLS = "clave, proveedor, valor, fuente, nota, updated_at";

export class PostgresCfoCockpitRepository implements CfoCockpitRepository {
  constructor(private readonly db: TenantDbSession) {}

  listSupuestos(callerId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<SupuestoRaw>(`select ${SUPUESTO_COLS} from core.list_cfo_supuestos_for_superadmin($1);`, [callerId]);
        return { availability: "available" as const, supuestos: rows.map(mapSupuesto) };
      },
      () => ({ availability: "not_migrated" as const, supuestos: [] as readonly SupuestoCfoRow[] }),
    );
  }

  listSupuestosForSystem() {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<SupuestoRaw>(`select ${SUPUESTO_COLS} from core.list_cfo_supuestos_for_system();`);
        return { availability: "available" as const, supuestos: rows.map(mapSupuesto) };
      },
      () => ({ availability: "not_migrated" as const, supuestos: [] as readonly SupuestoCfoRow[] }),
    );
  }

  setSupuesto(callerId: string, clave: ClaveSupuestoCfo, proveedor: string, valor: number | null, fuente: string, nota: string | null) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_set_cfo_supuesto($1, $2, $3, $4::numeric, $5, $6);`, [callerId, clave, proveedor, valor, fuente, nota]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  listCapturas(callerId: string, desde: string, hasta: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ mes: string; tipo: TipoCapturaCfo; concepto: string; monto_mxn_centavos: string | number; nota: string | null }>(
          `select mes::text as mes, tipo, concepto, monto_mxn_centavos, nota from core.list_cfo_capturas_for_superadmin($1, $2::date, $3::date);`,
          [callerId, desde, hasta],
        );
        return {
          availability: "available" as const,
          capturas: rows.map((r): CapturaCfoRow => ({ mes: r.mes, tipo: r.tipo, concepto: r.concepto, montoMxnCentavos: Number(r.monto_mxn_centavos), nota: r.nota })),
        };
      },
      () => ({ availability: "not_migrated" as const, capturas: [] as readonly CapturaCfoRow[] }),
    );
  }

  setCaptura(callerId: string, mes: string, tipo: TipoCapturaCfo, concepto: string, montoMxnCentavos: number | null, nota: string | null) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_set_cfo_captura($1, $2::date, $3, $4, $5::bigint, $6);`, [callerId, mes, tipo, concepto, montoMxnCentavos, nota]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  getUso(callerId: string, desde: string, hasta: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<UsoRaw>(`select ${USO_COLS} from core.get_cfo_uso_for_superadmin($1, $2::date, $3::date);`, [callerId, desde, hasta]);
        return { availability: "available" as const, uso: rows.map(mapUso) };
      },
      () => ({ availability: "not_migrated" as const, uso: [] as readonly UsoCfoRow[] }),
    );
  }

  getUsoForSystem(desde: string, hasta: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<UsoRaw>(`select ${USO_COLS} from core.get_cfo_uso_for_system($1::date, $2::date);`, [desde, hasta]);
        return { availability: "available" as const, uso: rows.map(mapUso) };
      },
      () => ({ availability: "not_migrated" as const, uso: [] as readonly UsoCfoRow[] }),
    );
  }
}

const MES_RE = /^\d{4}-\d{2}-\d{2}$/u;
const mesDe = (fecha: string): string => `${fecha.slice(0, 7)}-01`;

/** Adaptador en memoria para los tests de rutas y del cron (misma semantica de acceso y validacion que el SQL). */
export class InMemoryCfoCockpitRepository implements CfoCockpitRepository {
  private readonly superadmins = new Set<string>();
  private readonly finanzas = new Set<string>();
  private readonly supuestos = new Map<string, SupuestoCfoRow>();
  private readonly capturas = new Map<string, CapturaCfoRow>();
  private uso: UsoCfoRow[] = [];
  readonly bitacora: Array<{ actor: string; evento: string; detalle: Record<string, unknown> }> = [];
  constructor(private readonly opciones: { readonly migrado?: boolean; readonly now?: () => number } = {}) {}

  seedSuperadmin(userId: string, rol: "superadmin" | "finanzas" = "superadmin"): void {
    this.superadmins.add(userId);
    if (rol === "finanzas") this.finanzas.add(userId);
  }
  seedUso(rows: readonly UsoCfoRow[]): void {
    this.uso = [...rows];
  }
  seedSupuesto(row: SupuestoCfoRow): void {
    this.supuestos.set(`${row.clave}|${row.proveedor}`, row);
  }
  seedCaptura(row: CapturaCfoRow): void {
    this.capturas.set(`${row.mes}|${row.tipo}|${row.concepto.trim().toLowerCase()}`, row);
  }

  private get migrado(): boolean {
    return this.opciones.migrado ?? true;
  }
  private escritor(callerId: string, fn: string): void {
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError(`${fn}: solo un superadmin de plataforma`, "forbidden");
    if (this.finanzas.has(callerId)) throw new SuperadminSeguridadError(`${fn}: rol finanzas de solo lectura`, "forbidden");
  }

  async listSupuestos(callerId: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, supuestos: [] as readonly SupuestoCfoRow[] };
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, supuestos: [] as readonly SupuestoCfoRow[] };
    return this.listSupuestosForSystem();
  }

  async listSupuestosForSystem() {
    if (!this.migrado) return { availability: "not_migrated" as const, supuestos: [] as readonly SupuestoCfoRow[] };
    const supuestos = [...this.supuestos.values()].sort((a, b) => a.clave.localeCompare(b.clave) || a.proveedor.localeCompare(b.proveedor));
    return { availability: "available" as const, supuestos };
  }

  async setSupuesto(callerId: string, clave: ClaveSupuestoCfo, proveedor: string, valor: number | null, fuente: string, nota: string | null) {
    if (!this.migrado) return { availability: "not_migrated" as const };
    this.escritor(callerId, "superadmin_set_cfo_supuesto");
    const prov = proveedor.trim() === "" ? "*" : proveedor.trim();
    if (!(CLAVES_SUPUESTO_CFO as readonly string[]).includes(clave)) throw new SuperadminSeguridadError("clave desconocida", "invalid");
    if (prov !== "*" && clave !== "voz_usd_minuto" && clave !== "telefonia_usd_minuto") throw new SuperadminSeguridadError("solo voz y telefonia distinguen proveedor", "invalid");
    const k = `${clave}|${prov}`;
    if (valor === null) {
      if (this.supuestos.delete(k)) this.bitacora.push({ actor: callerId, evento: "supuesto_borrado", detalle: { clave, proveedor: prov } });
      return { availability: "available" as const };
    }
    if (!Number.isFinite(valor) || valor < 0 || valor > 1_000_000) throw new SuperadminSeguridadError("valor fuera de rango", "invalid");
    if (clave.startsWith("umbral_") && valor > 1000) throw new SuperadminSeguridadError("umbral fuera de rango", "invalid");
    if (fuente.trim().length < 3 || fuente.trim().length > 200) throw new SuperadminSeguridadError("indica la fuente", "invalid");
    this.supuestos.set(k, { clave, proveedor: prov, valor, fuente: fuente.trim(), nota, updatedAt: new Date(this.opciones.now?.() ?? Date.now()).toISOString() });
    this.bitacora.push({ actor: callerId, evento: "supuesto_set", detalle: { clave, proveedor: prov, valor, fuente: fuente.trim() } });
    return { availability: "available" as const };
  }

  async listCapturas(callerId: string, desde: string, hasta: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, capturas: [] as readonly CapturaCfoRow[] };
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, capturas: [] as readonly CapturaCfoRow[] };
    const capturas = [...this.capturas.values()]
      .filter((c) => c.mes.slice(0, 7) >= desde.slice(0, 7) && c.mes.slice(0, 7) <= hasta.slice(0, 7))
      .sort((a, b) => a.mes.localeCompare(b.mes) || a.tipo.localeCompare(b.tipo) || a.concepto.localeCompare(b.concepto));
    return { availability: "available" as const, capturas };
  }

  async setCaptura(callerId: string, mes: string, tipo: TipoCapturaCfo, concepto: string, montoMxnCentavos: number | null, nota: string | null) {
    if (!this.migrado) return { availability: "not_migrated" as const };
    this.escritor(callerId, "superadmin_set_cfo_captura");
    if (!MES_RE.test(mes)) throw new SuperadminSeguridadError("mes invalido", "invalid");
    if (!(TIPOS_CAPTURA_CFO as readonly string[]).includes(tipo)) throw new SuperadminSeguridadError("tipo desconocido", "invalid");
    const m = mesDe(mes);
    const actual = mesDe(new Date(this.opciones.now?.() ?? Date.now()).toISOString().slice(0, 10));
    if (!tipo.startsWith("presupuesto_") && m > actual) throw new SuperadminSeguridadError("solo el presupuesto admite meses futuros", "invalid");
    const c = concepto.trim();
    if (c.length < 2 || c.length > 80) throw new SuperadminSeguridadError("concepto de 2 a 80 caracteres", "invalid");
    const k = `${m}|${tipo}|${c.toLowerCase()}`;
    if (montoMxnCentavos === null) {
      if (this.capturas.delete(k)) this.bitacora.push({ actor: callerId, evento: "captura_borrada", detalle: { mes: m, tipo, concepto: c } });
      return { availability: "available" as const };
    }
    if (!Number.isInteger(montoMxnCentavos) || montoMxnCentavos < 0 || montoMxnCentavos > 100_000_000_000) throw new SuperadminSeguridadError("monto fuera de rango", "invalid");
    this.capturas.set(k, { mes: m, tipo, concepto: c, montoMxnCentavos, nota });
    this.bitacora.push({ actor: callerId, evento: "captura_set", detalle: { mes: m, tipo, concepto: c, montoMxnCentavos } });
    return { availability: "available" as const };
  }

  async getUso(callerId: string, desde: string, hasta: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, uso: [] as readonly UsoCfoRow[] };
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, uso: [] as readonly UsoCfoRow[] };
    return this.getUsoForSystem(desde, hasta);
  }

  async getUsoForSystem(desde: string, hasta: string) {
    if (!this.migrado) return { availability: "not_migrated" as const, uso: [] as readonly UsoCfoRow[] };
    const uso = this.uso.filter((u) => u.mes.slice(0, 7) >= desde.slice(0, 7) && u.mes.slice(0, 7) <= hasta.slice(0, 7));
    return { availability: "available" as const, uso };
  }
}
