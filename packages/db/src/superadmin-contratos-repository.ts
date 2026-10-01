// Repositorio del contrato por cliente (SA-43, superadmin "CFO") -- puerto contra las funciones
// `security definer` de packages/db/migrations/0037_superadmin_contrato_cliente.sql.
//
// SESIONES: todos los metodos son caller-bound (`withAppSession({ userId: callerId })`); esta clase no
// elige la sesion, recibe el `TenantDbSession` ya abierto.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada metodo corre bajo `runWithSavepointFallback`. Un SQLSTATE
// 42883/42P01/42703 (migracion 0037 sin aplicar) revierte SOLO el savepoint (la transaccion de la sesion
// sigue viva) y devuelve `availability: "not_migrated"` con datos vacios; nunca un 500 ni un exito
// simulado. Los errores de negocio de SQL (42501, 22023, P0002, 23P01, 23505...) se tipan como
// `SuperadminSeguridadError`.
//
// Dinero: centavos MXN ENTEROS (bigint llega como string del driver: se convierte con Number, dentro del
// rango seguro por los CHECK de la tabla). Fechas: `YYYY-MM-DD` (se formatean en SQL con to_char para que
// el driver no las convierta a Date con zona horaria).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";
import { SuperadminSeguridadError } from "./superadmin-seguridad-repository.ts";
import type { CostosAvailability } from "./superadmin-costos-planes-repository.ts";

export interface ContratoVersionRow {
  readonly id: string;
  readonly contractId: string;
  readonly organizationId: string;
  readonly organizationName: string | null;
  readonly version: number;
  readonly vigenteDesde: string;
  readonly vigenteHasta: string | null;
  readonly moneda: "MXN";
  readonly baseCentavos: number;
  readonly porSucursalCentavos: number;
  readonly sucursalesIncluidas: number;
  readonly bolsaMinutos: number;
  readonly excedenteCentavosMinuto: number;
  readonly instalacionCentavos: number;
  readonly descuentoBp: number;
  readonly descuentoFijoCentavos: number;
  readonly motivo: string;
  readonly creadoPor: string;
  readonly creadoPorCorreo: string | null;
  readonly creadoEnMs: number;
}

export interface TerminosContratoInput {
  readonly vigenteDesde: string;
  readonly vigenteHasta: string | null;
  readonly baseCentavos: number;
  readonly porSucursalCentavos: number;
  readonly sucursalesIncluidas: number;
  readonly bolsaMinutos: number;
  readonly excedenteCentavosMinuto: number;
  readonly instalacionCentavos: number;
  readonly descuentoBp: number;
  readonly descuentoFijoCentavos: number;
  readonly motivo: string;
}

export interface InsumosFacturacionRow {
  readonly sucursalesActivas: number;
  readonly minutosVoz: number;
  /** Cuantos eventos de voz respaldan `minutosVoz`; 0 = minutos NO medidos (no es "cero minutos"). */
  readonly eventosVoz: number;
}

export interface ContratosRepository {
  /** CALLER (superadmin o finanzas). Historial de versiones, la mas reciente primero. */
  listVersions(callerId: string, organizationId: string | null, limit?: number): Promise<{ availability: CostosAvailability; versions: readonly ContratoVersionRow[] }>;
  /** CALLER (superadmin no restringido). Alta: version 1. */
  createContract(callerId: string, organizationId: string, terminos: TerminosContratoInput): Promise<{ availability: CostosAvailability; contractId: string | null }>;
  /** CALLER (superadmin no restringido). Enmienda: version n+1. */
  amendContract(callerId: string, contractId: string, terminos: TerminosContratoInput): Promise<{ availability: CostosAvailability; version: number | null }>;
  /** CALLER. `mes` = `YYYY-MM`. `inputs: null` si no hay (organizacion inexistente o sin acceso). */
  getBillingInputs(callerId: string, organizationId: string, mes: string): Promise<{ availability: CostosAvailability; inputs: InsumosFacturacionRow | null }>;
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
    case "22008":
      return new SuperadminSeguridadError(message, "invalid");
    case "P0002":
      return new SuperadminSeguridadError(message, "not_found");
    case "55006":
    case "23505":
    case "23P01":
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
    "superadmin-contratos-repository: las funciones/tablas de 0037_superadmin_contrato_cliente.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible aun' (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para habilitar el contrato por cliente.",
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

const num = (v: string | number): number => Number(v);

interface VersionRaw {
  id: string;
  contract_id: string;
  organization_id: string;
  organization_name: string | null;
  version: number;
  vigente_desde: string;
  vigente_hasta: string | null;
  moneda: "MXN";
  base_centavos: string | number;
  por_sucursal_centavos: string | number;
  sucursales_incluidas: number;
  bolsa_minutos: number;
  excedente_centavos_minuto: string | number;
  instalacion_centavos: string | number;
  descuento_bp: number;
  descuento_fijo_centavos: string | number;
  motivo: string;
  created_by: string;
  created_by_email: string | null;
  created_at: string;
}

export function mapVersion(r: VersionRaw): ContratoVersionRow {
  return {
    id: r.id,
    contractId: r.contract_id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    version: r.version,
    vigenteDesde: r.vigente_desde,
    vigenteHasta: r.vigente_hasta,
    moneda: r.moneda,
    baseCentavos: num(r.base_centavos),
    porSucursalCentavos: num(r.por_sucursal_centavos),
    sucursalesIncluidas: r.sucursales_incluidas,
    bolsaMinutos: r.bolsa_minutos,
    excedenteCentavosMinuto: num(r.excedente_centavos_minuto),
    instalacionCentavos: num(r.instalacion_centavos),
    descuentoBp: r.descuento_bp,
    descuentoFijoCentavos: num(r.descuento_fijo_centavos),
    motivo: r.motivo,
    creadoPor: r.created_by,
    creadoPorCorreo: r.created_by_email,
    creadoEnMs: new Date(r.created_at).getTime(),
  };
}

const TERMINOS_ARGS = (t: TerminosContratoInput): unknown[] => [
  t.vigenteDesde,
  t.vigenteHasta,
  t.baseCentavos,
  t.porSucursalCentavos,
  t.sucursalesIncluidas,
  t.bolsaMinutos,
  t.excedenteCentavosMinuto,
  t.instalacionCentavos,
  t.descuentoBp,
  t.descuentoFijoCentavos,
  t.motivo,
];

export class PostgresContratosRepository implements ContratosRepository {
  constructor(private readonly db: TenantDbSession) {}

  listVersions(callerId: string, organizationId: string | null, limit = 200) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<VersionRaw>(
          `select id, contract_id, organization_id, organization_name, version,
                  to_char(vigente_desde, 'YYYY-MM-DD') as vigente_desde, to_char(vigente_hasta, 'YYYY-MM-DD') as vigente_hasta,
                  moneda, base_centavos, por_sucursal_centavos, sucursales_incluidas, bolsa_minutos, excedente_centavos_minuto,
                  instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by, created_by_email, created_at
             from core.list_customer_contracts_for_superadmin($1, $2, $3);`,
          [callerId, organizationId, limit],
        );
        return { availability: "available" as const, versions: rows.map(mapVersion) };
      },
      () => ({ availability: "not_migrated" as const, versions: [] as readonly ContratoVersionRow[] }),
    );
  }

  createContract(callerId: string, organizationId: string, terminos: TerminosContratoInput) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ contract_id: string }>(
          `select core.superadmin_create_contract($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13) as contract_id;`,
          [callerId, organizationId, ...TERMINOS_ARGS(terminos)],
        );
        return { availability: "available" as const, contractId: rows[0]?.contract_id ?? null };
      },
      () => ({ availability: "not_migrated" as const, contractId: null }),
    );
  }

  amendContract(callerId: string, contractId: string, terminos: TerminosContratoInput) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ version: number }>(
          `select core.superadmin_amend_contract($1, $2, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13) as version;`,
          [callerId, contractId, ...TERMINOS_ARGS(terminos)],
        );
        return { availability: "available" as const, version: rows[0]?.version ?? null };
      },
      () => ({ availability: "not_migrated" as const, version: null }),
    );
  }

  getBillingInputs(callerId: string, organizationId: string, mes: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ sucursales_activas: number; minutos_voz: string | number; eventos_voz: string | number }>(
          `select sucursales_activas, minutos_voz, eventos_voz from core.get_contract_billing_inputs_for_superadmin($1, $2, $3::date);`,
          [callerId, organizationId, `${mes}-01`],
        );
        const r = rows[0];
        return {
          availability: "available" as const,
          inputs: r ? ({ sucursalesActivas: r.sucursales_activas, minutosVoz: num(r.minutos_voz), eventosVoz: num(r.eventos_voz) } satisfies InsumosFacturacionRow) : null,
        };
      },
      () => ({ availability: "not_migrated" as const, inputs: null as InsumosFacturacionRow | null }),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// En memoria (tests de rutas; replica las reglas de la migracion)
// ═══════════════════════════════════════════════════════════════════════════
interface InMemoryClock {
  readonly now?: () => number;
}

const MAX_CENTAVOS = 100_000_000_000;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/u;

function inicioDeMesMx(ms: number): string {
  // Hora de Mexico (UTC-6 todo el año desde 2022, sin horario de verano): suficiente para el reloj de pruebas.
  const d = new Date(ms - 6 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export class InMemoryContratosRepository implements ContratosRepository {
  private readonly superadmins = new Set<string>();
  private readonly finanzas = new Set<string>();
  private readonly orgs = new Map<string, { name: string; sucursalesActivas: number }>();
  private readonly voz = new Map<string, { minutos: number; eventos: number }>();
  private readonly emails = new Map<string, string>();
  private readonly versions: ContratoVersionRow[] = [];
  private idSeq = 0;
  constructor(private readonly clock: InMemoryClock = {}) {}

  private now(): number {
    return (this.clock.now ?? Date.now)();
  }
  seedSuperadmin(userId: string, email?: string): void {
    this.superadmins.add(userId);
    if (email) this.emails.set(userId, email);
  }
  /** Superadmin restringido al rol `finanzas` (solo lectura). */
  seedFinanzas(userId: string, email?: string): void {
    this.seedSuperadmin(userId, email);
    this.finanzas.add(userId);
  }
  seedOrganization(id: string, name: string, sucursalesActivas = 0): void {
    this.orgs.set(id, { name, sucursalesActivas });
  }
  seedVoz(organizationId: string, mes: string, minutos: number, eventos: number): void {
    this.voz.set(`${organizationId}|${mes}`, { minutos, eventos });
  }

  private requireWriter(callerId: string, fn: string): void {
    if (!this.superadmins.has(callerId) || this.finanzas.has(callerId)) throw new SuperadminSeguridadError(`${fn}: solo un superadmin de plataforma real puede ejecutar esta accion`, "forbidden");
  }

  private validar(t: TerminosContratoInput): void {
    const montos = [t.baseCentavos, t.porSucursalCentavos, t.excedenteCentavosMinuto, t.instalacionCentavos, t.descuentoFijoCentavos];
    if (montos.some((m) => !Number.isInteger(m) || m < 0 || m > MAX_CENTAVOS)) throw new SuperadminSeguridadError("los montos (centavos MXN) deben ser enteros entre 0 y 100000000000", "invalid");
    if (!Number.isInteger(t.sucursalesIncluidas) || t.sucursalesIncluidas < 0 || t.sucursalesIncluidas > 100_000) throw new SuperadminSeguridadError("sucursales_incluidas fuera de rango", "invalid");
    if (!Number.isInteger(t.bolsaMinutos) || t.bolsaMinutos < 0 || t.bolsaMinutos > 100_000_000) throw new SuperadminSeguridadError("bolsa_minutos fuera de rango", "invalid");
    if (!Number.isInteger(t.descuentoBp) || t.descuentoBp < 0 || t.descuentoBp > 10_000) throw new SuperadminSeguridadError("descuento_bp debe estar entre 0 y 10000", "invalid");
    if (!FECHA_RE.test(t.vigenteDesde) || (t.vigenteHasta !== null && !FECHA_RE.test(t.vigenteHasta))) throw new SuperadminSeguridadError("fecha invalida", "invalid");
    if (t.vigenteHasta !== null && t.vigenteHasta < t.vigenteDesde) throw new SuperadminSeguridadError("vigente_hasta no puede ser anterior a vigente_desde", "invalid");
    const motivo = t.motivo.trim();
    if (motivo.length < 20 || motivo.length > 500) throw new SuperadminSeguridadError("motivo obligatorio (20-500 caracteres)", "invalid");
  }

  /** Tramo [primera version, fin de la ultima] de cada contrato de la organizacion, salvo `excluir`. */
  private tramos(organizationId: string, excluir: string | null): Array<{ desde: string; hasta: string | null }> {
    const porContrato = new Map<string, ContratoVersionRow[]>();
    for (const v of this.versions) {
      if (v.organizationId !== organizationId || v.contractId === excluir) continue;
      const l = porContrato.get(v.contractId) ?? [];
      l.push(v);
      porContrato.set(v.contractId, l);
    }
    return [...porContrato.values()].map((l) => {
      const ordenadas = [...l].sort((a, b) => a.version - b.version);
      return { desde: (ordenadas[0] as ContratoVersionRow).vigenteDesde, hasta: (ordenadas[ordenadas.length - 1] as ContratoVersionRow).vigenteHasta };
    });
  }

  private seTraslapa(a: { desde: string; hasta: string | null }, b: { desde: string; hasta: string | null }): boolean {
    return a.desde <= (b.hasta ?? "9999-12-31") && b.desde <= (a.hasta ?? "9999-12-31");
  }

  private push(contractId: string, organizationId: string, version: number, t: TerminosContratoInput, callerId: string): void {
    this.idSeq += 1;
    this.versions.push({
      id: `ver-${this.idSeq}`,
      contractId,
      organizationId,
      organizationName: this.orgs.get(organizationId)?.name ?? null,
      version,
      vigenteDesde: t.vigenteDesde,
      vigenteHasta: t.vigenteHasta,
      moneda: "MXN",
      baseCentavos: t.baseCentavos,
      porSucursalCentavos: t.porSucursalCentavos,
      sucursalesIncluidas: t.sucursalesIncluidas,
      bolsaMinutos: t.bolsaMinutos,
      excedenteCentavosMinuto: t.excedenteCentavosMinuto,
      instalacionCentavos: t.instalacionCentavos,
      descuentoBp: t.descuentoBp,
      descuentoFijoCentavos: t.descuentoFijoCentavos,
      motivo: t.motivo.trim(),
      creadoPor: callerId,
      creadoPorCorreo: this.emails.get(callerId) ?? null,
      creadoEnMs: this.now(),
    });
  }

  async listVersions(callerId: string, organizationId: string | null, limit = 200) {
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, versions: [] as readonly ContratoVersionRow[] };
    const filas = this.versions.filter((v) => organizationId === null || v.organizationId === organizationId);
    return { availability: "available" as const, versions: [...filas].reverse().slice(0, Math.max(1, Math.min(limit, 500))) };
  }

  async createContract(callerId: string, organizationId: string, t: TerminosContratoInput) {
    this.requireWriter(callerId, "superadmin_create_contract");
    if (!this.orgs.has(organizationId)) throw new SuperadminSeguridadError("la organizacion no existe", "not_found");
    this.validar(t);
    if (this.tramos(organizationId, null).some((o) => this.seTraslapa(o, { desde: t.vigenteDesde, hasta: t.vigenteHasta }))) {
      throw new SuperadminSeguridadError("las vigencias de dos contratos de la misma organizacion no pueden traslaparse", "conflict");
    }
    this.idSeq += 1;
    const contractId = `ctr-${this.idSeq}`;
    this.push(contractId, organizationId, 1, t, callerId);
    return { availability: "available" as const, contractId };
  }

  async amendContract(callerId: string, contractId: string, t: TerminosContratoInput) {
    this.requireWriter(callerId, "superadmin_amend_contract");
    const lista = this.versions.filter((v) => v.contractId === contractId);
    const ultima = lista[lista.length - 1];
    if (!ultima) throw new SuperadminSeguridadError("el contrato no existe", "not_found");
    this.validar(t);
    if (t.vigenteDesde < inicioDeMesMx(this.now())) throw new SuperadminSeguridadError("una enmienda no puede comenzar antes del primer dia del mes en curso", "invalid");
    if (
      ultima.baseCentavos === t.baseCentavos &&
      ultima.porSucursalCentavos === t.porSucursalCentavos &&
      ultima.sucursalesIncluidas === t.sucursalesIncluidas &&
      ultima.bolsaMinutos === t.bolsaMinutos &&
      ultima.excedenteCentavosMinuto === t.excedenteCentavosMinuto &&
      ultima.instalacionCentavos === t.instalacionCentavos &&
      ultima.descuentoBp === t.descuentoBp &&
      ultima.descuentoFijoCentavos === t.descuentoFijoCentavos &&
      ultima.vigenteHasta === t.vigenteHasta
    ) {
      throw new SuperadminSeguridadError("la enmienda no cambia ninguna condicion", "invalid");
    }
    if (t.vigenteDesde <= ultima.vigenteDesde) throw new SuperadminSeguridadError("vigente_desde debe ser posterior al de la version anterior", "invalid");
    if (ultima.vigenteHasta !== null && t.vigenteDesde > ultima.vigenteHasta) throw new SuperadminSeguridadError("una enmienda no puede comenzar despues del fin del contrato", "invalid");
    const primera = lista[0] as ContratoVersionRow;
    if (this.tramos(ultima.organizationId, contractId).some((o) => this.seTraslapa(o, { desde: primera.vigenteDesde, hasta: t.vigenteHasta }))) {
      throw new SuperadminSeguridadError("las vigencias de dos contratos de la misma organizacion no pueden traslaparse", "conflict");
    }
    this.push(contractId, ultima.organizationId, ultima.version + 1, t, callerId);
    return { availability: "available" as const, version: ultima.version + 1 };
  }

  async getBillingInputs(callerId: string, organizationId: string, mes: string) {
    const org = this.orgs.get(organizationId);
    if (!this.superadmins.has(callerId) || !org) return { availability: "available" as const, inputs: null as InsumosFacturacionRow | null };
    const v = this.voz.get(`${organizationId}|${mes}`);
    return { availability: "available" as const, inputs: { sucursalesActivas: org.sucursalesActivas, minutosVoz: v?.minutos ?? 0, eventosVoz: v?.eventos ?? 0 } };
  }
}
