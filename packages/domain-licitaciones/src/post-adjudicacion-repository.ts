// L-27 -- almacenamiento de la post-adjudicacion (tablas/funciones de la migracion 035). Modulo APARTE de
// `repository.ts`/`postgres-repository.ts` (mismo criterio que `kyc-69b-repository.ts`: archivos compartidos por
// varias ramas en paralelo).
//
// REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la API se despliega antes que la migracion 035. Cada operacion corre
// dentro de `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) porque la sesion del request es UNA
// transaccion: un 42P01/42703/42883 sin savepoint la dejaria abortada (25P02) y el COMMIT revertiria todo en silencio.
// Si falta la migracion se lanza `PostAdjudicacionNotAvailableError`; el llamador decide: lecturas -> "no disponible
// aun", escrituras -> 503. Nunca un 500.
//
// Los errores de negocio que la base lanza a proposito (22023 estado/entrada, 42501 rol, 54000 tope, 23514 check) NO son
// "migracion pendiente": se traducen a errores tipados.
//
// El aislamiento por organizacion lo hace la RLS (migracion 035); TODAS las consultas ademas filtran por
// `organization_id` (defensa en profundidad: el id de otro tenant responde "no encontrado", nunca "prohibido").
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { fromCents } from "./money.ts";
import {
  GARANTIA_ESTADOS_DE_DECISION,
  PostAdjudicacionForbiddenError,
  PostAdjudicacionNotAvailableError,
  PostAdjudicacionNotFoundError,
  PostAdjudicacionStateError,
  PostAdjudicacionValidationError,
  assertGarantiaTransicion,
  evaluarGarantia,
  evaluarHito,
  isAlertaTipo,
  isGarantiaEstado,
  isGarantiaFinal,
  isGarantiaTipo,
  isHitoEstado,
} from "./post-adjudicacion.ts";
import type {
  BitacoraEntrada,
  ContractPlazos,
  Convenio,
  ConvenioInput,
  ConvenioTipo,
  Garantia,
  GarantiaInput,
  GarantiaPatch,
  Hito,
  HitoInput,
  HitoPatch,
  PlazosInput,
  PostAdjudicacionAlertaCandidata,
  Responsable,
} from "./post-adjudicacion.ts";

/** Quien escribe: su id y si su rol puede decidir (liberar/ejecutar una garantia). */
export interface PostAdjudicacionActor {
  readonly userId: string;
  readonly canDecide: boolean;
}

export interface GarantiaCreate extends Omit<GarantiaInput, "fechaLimiteEntrega"> {
  /** Ya resuelta por el servidor (calculada de los plazos o declarada). */
  readonly fechaLimiteEntrega: string | null;
}

export interface PostAdjudicacionRepository {
  getPlazos(organizationId: string, contractId: string): Promise<ContractPlazos | null>;
  upsertPlazos(organizationId: string, contractId: string, input: PlazosInput, actorId: string): Promise<ContractPlazos>;
  /** Recalcula la fecha limite de entrega de las garantias de cumplimiento aun pendientes (tras cambiar los plazos). */
  setLimiteEntregaPendientes(organizationId: string, contractId: string, fechaLimite: string | null): Promise<number>;

  listGarantias(organizationId: string, contractId: string): Promise<readonly Garantia[]>;
  getGarantia(organizationId: string, id: string): Promise<Garantia | null>;
  createGarantia(organizationId: string, contractId: string, input: GarantiaCreate, actorId: string): Promise<Garantia>;
  updateGarantia(organizationId: string, id: string, patch: GarantiaPatch, actor: PostAdjudicacionActor): Promise<Garantia>;

  listHitos(organizationId: string, contractId: string): Promise<readonly Hito[]>;
  getHito(organizationId: string, id: string): Promise<Hito | null>;
  createHito(organizationId: string, contractId: string, input: HitoInput, actorId: string): Promise<Hito>;
  updateHito(organizationId: string, id: string, patch: HitoPatch, actor: PostAdjudicacionActor): Promise<Hito>;

  listConvenios(organizationId: string, contractId: string): Promise<readonly Convenio[]>;
  /** `fechaFinAnterior`: la fecha de fin vigente del contrato (la base la lee ella misma; el repositorio en memoria usa esta). */
  createConvenio(organizationId: string, contractId: string, input: ConvenioInput, actorId: string, fechaFinAnterior: string | null): Promise<Convenio>;

  listBitacora(organizationId: string, contractId: string, limit?: number): Promise<readonly BitacoraEntrada[]>;
  listResponsables(organizationId: string): Promise<readonly Responsable[]>;
  /** Candidatos de alerta del barrido (lectura de sistema). `null` = base sin migrar. */
  listAlertCandidates(organizationId: string, hoy: string, ventanaDias: number): Promise<readonly PostAdjudicacionAlertaCandidata[] | null>;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

function dbCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function dbMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/** Traduce los SQLSTATE de negocio que la base lanza a proposito a errores tipados. El resto se repropaga. */
function mapBusinessError(err: unknown): never {
  const code = dbCode(err);
  const msg = dbMessage(err);
  if (code === "22023") {
    if (/ya esta|transicion|no se edita/i.test(msg)) throw new PostAdjudicacionStateError(msg);
    throw new PostAdjudicacionValidationError(msg || "Entrada inválida.");
  }
  if (code === "42501") {
    if (/exige un rol de decision/i.test(msg)) throw new PostAdjudicacionForbiddenError("Liberar o ejecutar una garantía exige un rol de decisión.");
    throw new PostAdjudicacionForbiddenError("Tu rol no puede hacer este cambio.");
  }
  if (code === "54000") throw new PostAdjudicacionValidationError(msg || "Se alcanzó el tope permitido.");
  if (code === "23514") throw new PostAdjudicacionValidationError("Algún dato no cumple las reglas de la base (montos, fechas o estado).");
  if (code === "23503") throw new PostAdjudicacionNotFoundError("El contrato o el responsable indicado no existe en tu organización.");
  if (code === "23505") throw new PostAdjudicacionStateError("Otro cambio simultáneo ocupó ese consecutivo: reintenta.");
  throw err;
}

const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const GARANTIA_COLS = `id, contract_id, tipo, monto_cents::text as monto_cents, porcentaje_bp, afianzadora, numero_poliza,
  vigencia_desde::text as vigencia_desde, vigencia_hasta::text as vigencia_hasta, fecha_limite_entrega::text as fecha_limite_entrega,
  entregada_en::text as entregada_en, estado, notas, ${TS("created_at")} as created_at, ${TS("updated_at")} as updated_at`;

const HITO_COLS = `id, contract_id, titulo, descripcion, responsable_id, fecha_compromiso::text as fecha_compromiso, estado,
  cumplido_en::text as cumplido_en, ${TS("created_at")} as created_at, ${TS("updated_at")} as updated_at`;

const CONVENIO_COLS = `id, contract_id, numero, tipo, monto_delta_cents::text as monto_delta_cents, nueva_fecha_fin::text as nueva_fecha_fin,
  fecha_fin_anterior::text as fecha_fin_anterior, fecha_firma::text as fecha_firma, motivo, ${TS("created_at")} as created_at`;

interface GarantiaRow {
  id: string;
  contract_id: string;
  tipo: string;
  monto_cents: string;
  porcentaje_bp: number | null;
  afianzadora: string | null;
  numero_poliza: string | null;
  vigencia_desde: string;
  vigencia_hasta: string;
  fecha_limite_entrega: string | null;
  entregada_en: string | null;
  estado: string;
  notas: string | null;
  created_at: string;
  updated_at: string;
}

function mapGarantia(r: GarantiaRow): Garantia {
  return {
    id: r.id,
    contractId: r.contract_id,
    tipo: isGarantiaTipo(r.tipo) ? r.tipo : "cumplimiento",
    monto: fromCents(BigInt(r.monto_cents)),
    porcentaje: r.porcentaje_bp === null ? null : Number(r.porcentaje_bp) / 100,
    afianzadora: r.afianzadora,
    numeroPoliza: r.numero_poliza,
    vigenciaDesde: r.vigencia_desde,
    vigenciaHasta: r.vigencia_hasta,
    fechaLimiteEntrega: r.fecha_limite_entrega,
    entregadaEn: r.entregada_en,
    estado: isGarantiaEstado(r.estado) ? r.estado : "pendiente_entrega",
    notas: r.notas,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface HitoRow {
  id: string;
  contract_id: string;
  titulo: string;
  descripcion: string | null;
  responsable_id: string | null;
  fecha_compromiso: string;
  estado: string;
  cumplido_en: string | null;
  created_at: string;
  updated_at: string;
}

function mapHito(r: HitoRow): Hito {
  return {
    id: r.id,
    contractId: r.contract_id,
    titulo: r.titulo,
    descripcion: r.descripcion,
    responsableId: r.responsable_id,
    fechaCompromiso: r.fecha_compromiso,
    estado: isHitoEstado(r.estado) ? r.estado : "pendiente",
    cumplidoEn: r.cumplido_en,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface ConvenioRow {
  id: string;
  contract_id: string;
  numero: number;
  tipo: string;
  monto_delta_cents: string | null;
  nueva_fecha_fin: string | null;
  fecha_fin_anterior: string | null;
  fecha_firma: string;
  motivo: string;
  created_at: string;
}

function mapConvenio(r: ConvenioRow): Convenio {
  return {
    id: r.id,
    contractId: r.contract_id,
    numero: Number(r.numero),
    tipo: r.tipo as ConvenioTipo,
    montoDelta: r.monto_delta_cents === null ? null : fromCents(BigInt(r.monto_delta_cents)),
    nuevaFechaFin: r.nueva_fecha_fin,
    fechaFinAnterior: r.fecha_fin_anterior,
    fechaFirma: r.fecha_firma,
    motivo: r.motivo,
    createdAt: r.created_at,
  };
}

interface PlazosRow {
  contract_id: string;
  fallo_notificado_en: string | null;
  plazo_firma_dias: number | null;
  firmado_en: string | null;
  plazo_garantia_dias: number | null;
  updated_at: string;
}

function mapPlazos(r: PlazosRow): ContractPlazos {
  return {
    contractId: r.contract_id,
    falloNotificadoEn: r.fallo_notificado_en,
    plazoFirmaDias: r.plazo_firma_dias,
    firmadoEn: r.firmado_en,
    plazoGarantiaDias: r.plazo_garantia_dias,
    updatedAt: r.updated_at,
  };
}

/** Arma `set col = $n, ...` solo con columnas de una lista blanca fija (nunca nombres del cliente). */
function buildSet(pairs: readonly (readonly [column: string, value: unknown])[], firstParam: number): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  const parts = pairs.map(([column, value], i) => {
    values.push(value);
    return `${column} = $${firstParam + i}`;
  });
  return { sql: parts.join(", "), values };
}

export class PostgresPostAdjudicacionRepository implements PostAdjudicacionRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** `primary` en un SAVEPOINT; base sin migrar (42P01/42703/42883) -> `PostAdjudicacionNotAvailableError` con la sesion ya recuperada. */
  private guarded<T>(primary: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      primary,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        throw new PostAdjudicacionNotAvailableError();
      },
    });
  }

  private async write<T>(primary: () => Promise<T>): Promise<T> {
    try {
      return await this.guarded(primary);
    } catch (err) {
      if (err instanceof PostAdjudicacionNotAvailableError || err instanceof PostAdjudicacionNotFoundError || err instanceof PostAdjudicacionStateError || err instanceof PostAdjudicacionForbiddenError || err instanceof PostAdjudicacionValidationError) throw err;
      return mapBusinessError(err);
    }
  }

  async getPlazos(organizationId: string, contractId: string): Promise<ContractPlazos | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<PlazosRow>(
        `select contract_id, fallo_notificado_en::text as fallo_notificado_en, plazo_firma_dias, firmado_en::text as firmado_en, plazo_garantia_dias, ${TS("updated_at")} as updated_at
         from licitaciones.contract_plazos where organization_id = $1 and contract_id = $2;`,
        [organizationId, contractId],
      );
      return rows[0] ? mapPlazos(rows[0]) : null;
    });
  }

  async upsertPlazos(organizationId: string, contractId: string, input: PlazosInput, actorId: string): Promise<ContractPlazos> {
    void actorId; // `updated_by` lo fija el trigger con auth.uid(); el id solo se acepta para igualar la firma del repositorio en memoria.
    return this.write(async () => {
      const actual = await this.getPlazosRaw(organizationId, contractId);
      const merged = {
        fallo: input.falloNotificadoEn !== undefined ? input.falloNotificadoEn : (actual?.fallo_notificado_en ?? null),
        firmaDias: input.plazoFirmaDias !== undefined ? input.plazoFirmaDias : (actual?.plazo_firma_dias ?? null),
        firmado: input.firmadoEn !== undefined ? input.firmadoEn : (actual?.firmado_en ?? null),
        garantiaDias: input.plazoGarantiaDias !== undefined ? input.plazoGarantiaDias : (actual?.plazo_garantia_dias ?? null),
      };
      const { rows } = await this.db.query<PlazosRow>(
        `insert into licitaciones.contract_plazos (contract_id, organization_id, fallo_notificado_en, plazo_firma_dias, firmado_en, plazo_garantia_dias)
         values ($2, $1, $3::date, $4, $5::date, $6)
         on conflict (contract_id) do update set fallo_notificado_en = excluded.fallo_notificado_en, plazo_firma_dias = excluded.plazo_firma_dias,
           firmado_en = excluded.firmado_en, plazo_garantia_dias = excluded.plazo_garantia_dias
         returning contract_id, fallo_notificado_en::text as fallo_notificado_en, plazo_firma_dias, firmado_en::text as firmado_en, plazo_garantia_dias, ${TS("updated_at")} as updated_at;`,
        [organizationId, contractId, merged.fallo, merged.firmaDias, merged.firmado, merged.garantiaDias],
      );
      return mapPlazos(rows[0]!);
    });
  }

  private async getPlazosRaw(organizationId: string, contractId: string): Promise<PlazosRow | null> {
    const { rows } = await this.db.query<PlazosRow>(
      `select contract_id, fallo_notificado_en::text as fallo_notificado_en, plazo_firma_dias, firmado_en::text as firmado_en, plazo_garantia_dias, ${TS("updated_at")} as updated_at
       from licitaciones.contract_plazos where organization_id = $1 and contract_id = $2;`,
      [organizationId, contractId],
    );
    return rows[0] ?? null;
  }

  async setLimiteEntregaPendientes(organizationId: string, contractId: string, fechaLimite: string | null): Promise<number> {
    return this.write(async () => {
      const { rows } = await this.db.query<{ id: string }>(
        `update licitaciones.contract_guarantee set fecha_limite_entrega = $3::date
         where organization_id = $1 and contract_id = $2 and tipo = 'cumplimiento' and estado = 'pendiente_entrega'
         returning id;`,
        [organizationId, contractId, fechaLimite],
      );
      return rows.length;
    });
  }

  async listGarantias(organizationId: string, contractId: string): Promise<readonly Garantia[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<GarantiaRow>(`select ${GARANTIA_COLS} from licitaciones.contract_guarantee where organization_id = $1 and contract_id = $2 order by vigencia_hasta, created_at, id;`, [organizationId, contractId]);
      return rows.map(mapGarantia);
    });
  }

  async getGarantia(organizationId: string, id: string): Promise<Garantia | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<GarantiaRow>(`select ${GARANTIA_COLS} from licitaciones.contract_guarantee where organization_id = $1 and id = $2;`, [organizationId, id]);
      return rows[0] ? mapGarantia(rows[0]) : null;
    });
  }

  async createGarantia(organizationId: string, contractId: string, input: GarantiaCreate, actorId: string): Promise<Garantia> {
    return this.write(async () => {
      const { rows } = await this.db.query<GarantiaRow>(
        `insert into licitaciones.contract_guarantee
           (organization_id, contract_id, tipo, monto_cents, porcentaje_bp, afianzadora, numero_poliza, vigencia_desde, vigencia_hasta, fecha_limite_entrega, entregada_en, estado, notas, created_by)
         values ($1, $2, $3, $4::bigint, $5, $6, $7, $8::date, $9::date, $10::date, $11::date, $12, $13, $14)
         returning ${GARANTIA_COLS};`,
        [
          organizationId,
          contractId,
          input.tipo,
          input.montoCents.toString(),
          input.porcentajeBp,
          input.afianzadora,
          input.numeroPoliza,
          input.vigenciaDesde,
          input.vigenciaHasta,
          input.fechaLimiteEntrega,
          input.entregadaEn,
          input.entregadaEn ? "entregada" : "pendiente_entrega",
          input.notas,
          actorId,
        ],
      );
      return mapGarantia(rows[0]!);
    });
  }

  async updateGarantia(organizationId: string, id: string, patch: GarantiaPatch, actor: PostAdjudicacionActor): Promise<Garantia> {
    return this.write(async () => {
      const { rows: cur } = await this.db.query<GarantiaRow>(`select ${GARANTIA_COLS} from licitaciones.contract_guarantee where organization_id = $1 and id = $2 for update;`, [organizationId, id]);
      if (!cur[0]) throw new PostAdjudicacionNotFoundError("Garantía no encontrada.");
      const actual = mapGarantia(cur[0]);
      if (isGarantiaFinal(actual.estado)) throw new PostAdjudicacionStateError(`La garantía ya está ${actual.estado} y no admite más cambios.`);
      if (patch.estado !== undefined && patch.estado !== actual.estado) {
        assertGarantiaTransicion(actual.estado, patch.estado);
        if (GARANTIA_ESTADOS_DE_DECISION.includes(patch.estado) && !actor.canDecide) throw new PostAdjudicacionForbiddenError("Liberar o ejecutar una garantía exige un rol de decisión.");
      }
      const pairs: (readonly [string, unknown])[] = [];
      if (patch.montoCents !== undefined) pairs.push(["monto_cents", patch.montoCents.toString()]);
      if (patch.porcentajeBp !== undefined) pairs.push(["porcentaje_bp", patch.porcentajeBp]);
      if (patch.afianzadora !== undefined) pairs.push(["afianzadora", patch.afianzadora]);
      if (patch.numeroPoliza !== undefined) pairs.push(["numero_poliza", patch.numeroPoliza]);
      if (patch.vigenciaDesde !== undefined) pairs.push(["vigencia_desde", patch.vigenciaDesde]);
      if (patch.vigenciaHasta !== undefined) pairs.push(["vigencia_hasta", patch.vigenciaHasta]);
      if (patch.fechaLimiteEntrega !== undefined) pairs.push(["fecha_limite_entrega", patch.fechaLimiteEntrega]);
      if (patch.entregadaEn !== undefined) pairs.push(["entregada_en", patch.entregadaEn]);
      if (patch.notas !== undefined) pairs.push(["notas", patch.notas]);
      if (patch.estado !== undefined) pairs.push(["estado", patch.estado]);
      const { sql, values } = buildSet(pairs, 3);
      const { rows } = await this.db.query<GarantiaRow>(`update licitaciones.contract_guarantee set ${sql} where organization_id = $1 and id = $2 returning ${GARANTIA_COLS};`, [organizationId, id, ...values]);
      return mapGarantia(rows[0]!);
    });
  }

  async listHitos(organizationId: string, contractId: string): Promise<readonly Hito[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<HitoRow>(`select ${HITO_COLS} from licitaciones.contract_milestone where organization_id = $1 and contract_id = $2 order by fecha_compromiso, created_at, id;`, [organizationId, contractId]);
      return rows.map(mapHito);
    });
  }

  async getHito(organizationId: string, id: string): Promise<Hito | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<HitoRow>(`select ${HITO_COLS} from licitaciones.contract_milestone where organization_id = $1 and id = $2;`, [organizationId, id]);
      return rows[0] ? mapHito(rows[0]) : null;
    });
  }

  async createHito(organizationId: string, contractId: string, input: HitoInput, actorId: string): Promise<Hito> {
    return this.write(async () => {
      const { rows } = await this.db.query<HitoRow>(
        `insert into licitaciones.contract_milestone (organization_id, contract_id, titulo, descripcion, responsable_id, fecha_compromiso, created_by)
         values ($1, $2, $3, $4, $5, $6::date, $7) returning ${HITO_COLS};`,
        [organizationId, contractId, input.titulo, input.descripcion, input.responsableId, input.fechaCompromiso, actorId],
      );
      return mapHito(rows[0]!);
    });
  }

  async updateHito(organizationId: string, id: string, patch: HitoPatch, actor: PostAdjudicacionActor): Promise<Hito> {
    void actor;
    return this.write(async () => {
      const { rows: cur } = await this.db.query<HitoRow>(`select ${HITO_COLS} from licitaciones.contract_milestone where organization_id = $1 and id = $2 for update;`, [organizationId, id]);
      if (!cur[0]) throw new PostAdjudicacionNotFoundError("Hito no encontrado.");
      if (cur[0].estado !== "pendiente") throw new PostAdjudicacionStateError(`El hito ya está ${cur[0].estado} y no admite más cambios.`);
      const pairs: (readonly [string, unknown])[] = [];
      if (patch.titulo !== undefined) pairs.push(["titulo", patch.titulo]);
      if (patch.descripcion !== undefined) pairs.push(["descripcion", patch.descripcion]);
      if (patch.responsableId !== undefined) pairs.push(["responsable_id", patch.responsableId]);
      if (patch.fechaCompromiso !== undefined) pairs.push(["fecha_compromiso", patch.fechaCompromiso]);
      if (patch.estado !== undefined) pairs.push(["estado", patch.estado]);
      if (patch.cumplidoEn !== undefined) pairs.push(["cumplido_en", patch.cumplidoEn]);
      const { sql, values } = buildSet(pairs, 3);
      const { rows } = await this.db.query<HitoRow>(`update licitaciones.contract_milestone set ${sql} where organization_id = $1 and id = $2 returning ${HITO_COLS};`, [organizationId, id, ...values]);
      return mapHito(rows[0]!);
    });
  }

  async listConvenios(organizationId: string, contractId: string): Promise<readonly Convenio[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ConvenioRow>(`select ${CONVENIO_COLS} from licitaciones.contract_amendment where organization_id = $1 and contract_id = $2 order by numero;`, [organizationId, contractId]);
      return rows.map(mapConvenio);
    });
  }

  async createConvenio(organizationId: string, contractId: string, input: ConvenioInput, actorId: string, fechaFinAnterior: string | null): Promise<Convenio> {
    void fechaFinAnterior; // la base la lee del contrato (trigger BEFORE INSERT).
    return this.write(async () => {
      const { rows } = await this.db.query<ConvenioRow>(
        `insert into licitaciones.contract_amendment (organization_id, contract_id, tipo, monto_delta_cents, nueva_fecha_fin, fecha_firma, motivo, created_by)
         values ($1, $2, $3, $4::bigint, $5::date, $6::date, $7, $8) returning ${CONVENIO_COLS};`,
        [organizationId, contractId, input.tipo, input.montoDeltaCents === null ? null : input.montoDeltaCents.toString(), input.nuevaFechaFin, input.fechaFirma, input.motivo, actorId],
      );
      return mapConvenio(rows[0]!);
    });
  }

  async listBitacora(organizationId: string, contractId: string, limit = 100): Promise<readonly BitacoraEntrada[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ id: string; entidad: string; entidad_id: string; accion: string; detalle: Record<string, unknown>; actor_id: string | null; created_at: string }>(
        `select id, entidad, entidad_id, accion, detalle, actor_id, ${TS("created_at")} as created_at
         from licitaciones.contract_post_award_log where organization_id = $1 and contract_id = $2 order by created_at desc, id desc limit $3;`,
        [organizationId, contractId, capped],
      );
      return rows.map((r) => ({ id: r.id, entidad: r.entidad as BitacoraEntrada["entidad"], entidadId: r.entidad_id, accion: r.accion as BitacoraEntrada["accion"], detalle: r.detalle ?? {}, actorId: r.actor_id, createdAt: r.created_at }));
    });
  }

  async listResponsables(organizationId: string): Promise<readonly Responsable[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ out_user_id: string; out_nombre: string; out_rol: string }>(`select * from licitaciones.post_award_list_responsables($1::uuid);`, [organizationId]);
      return rows.map((r) => ({ userId: r.out_user_id, nombre: r.out_nombre, rol: r.out_rol }));
    });
  }

  async listAlertCandidates(organizationId: string, hoy: string, ventanaDias: number): Promise<readonly PostAdjudicacionAlertaCandidata[] | null> {
    return runWithSavepointFallback<readonly PostAdjudicacionAlertaCandidata[] | null>({
      session: this.db,
      primary: async () => {
        const { rows } = await this.db.query<{ out_tipo: string; out_entidad_id: string; out_contract_id: string; out_tender_id: string; out_fecha: string }>(
          `select out_tipo, out_entidad_id, out_contract_id, out_tender_id, out_fecha::text as out_fecha from licitaciones.system_post_award_alert_candidates($1::uuid, $2::date, $3::integer);`,
          [organizationId, hoy, ventanaDias],
        );
        return rows.filter((r) => isAlertaTipo(r.out_tipo)).map((r) => ({ tipo: r.out_tipo as PostAdjudicacionAlertaCandidata["tipo"], entidadId: r.out_entidad_id, contractId: r.out_contract_id, tenderId: r.out_tender_id, fecha: r.out_fecha }));
      },
      isRecoverable: (err) => isMigrationPendingError(err, "system_post_award_alert_candidates"),
      fallback: async () => null,
    });
  }
}

// ---------------------------------------------------------------------------
// En memoria (pruebas HTTP; mismas reglas que la base)
// ---------------------------------------------------------------------------

interface MemGarantia extends Garantia {
  readonly organizationId: string;
}
interface MemHito extends Hito {
  readonly organizationId: string;
}
interface MemConvenio extends Convenio {
  readonly organizationId: string;
}
interface MemBitacora extends BitacoraEntrada {
  readonly organizationId: string;
  readonly contractId: string;
}

export interface InMemoryPostAdjudicacionOptions {
  /** Staff por organizacion (alimenta el selector y valida al responsable de un hito). */
  readonly responsables?: Readonly<Record<string, readonly Responsable[]>>;
  /** Reloj inyectable para los sellos de creacion. */
  readonly now?: () => string;
}

export class InMemoryPostAdjudicacionRepository implements PostAdjudicacionRepository {
  private readonly plazos = new Map<string, ContractPlazos & { organizationId: string }>();
  private readonly garantias = new Map<string, MemGarantia>();
  private readonly hitos = new Map<string, MemHito>();
  private readonly convenios: MemConvenio[] = [];
  private readonly bitacora: MemBitacora[] = [];
  private readonly responsables: Readonly<Record<string, readonly Responsable[]>>;
  private readonly now: () => string;
  private readonly contractTenders = new Map<string, string>();
  /** Asocia un contrato con su convocatoria (en la base lo resuelve el JOIN con `contract`); solo para las alertas. */
  linkContract(contractId: string, tenderId: string): void {
    this.contractTenders.set(contractId, tenderId);
  }
  /** Si se pone, toda operacion lanza `PostAdjudicacionNotAvailableError` (base sin la migracion 035). */
  unavailable = false;

  constructor(options: InMemoryPostAdjudicacionOptions = {}) {
    this.responsables = options.responsables ?? {};
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private guard(): void {
    if (this.unavailable) throw new PostAdjudicacionNotAvailableError();
  }

  private log(organizationId: string, contractId: string, entidad: BitacoraEntrada["entidad"], entidadId: string, accion: BitacoraEntrada["accion"], detalle: Record<string, unknown>, actorId: string | null): void {
    this.bitacora.push({ id: randomUUID(), organizationId, contractId, entidad, entidadId, accion, detalle, actorId, createdAt: this.now() });
  }

  async getPlazos(organizationId: string, contractId: string): Promise<ContractPlazos | null> {
    this.guard();
    const p = this.plazos.get(contractId);
    return p && p.organizationId === organizationId ? { ...p } : null;
  }

  async upsertPlazos(organizationId: string, contractId: string, input: PlazosInput, actorId: string): Promise<ContractPlazos> {
    this.guard();
    const prev = this.plazos.get(contractId);
    const base = prev && prev.organizationId === organizationId ? prev : undefined;
    const next = {
      organizationId,
      contractId,
      falloNotificadoEn: input.falloNotificadoEn !== undefined ? input.falloNotificadoEn : (base?.falloNotificadoEn ?? null),
      plazoFirmaDias: input.plazoFirmaDias !== undefined ? input.plazoFirmaDias : (base?.plazoFirmaDias ?? null),
      firmadoEn: input.firmadoEn !== undefined ? input.firmadoEn : (base?.firmadoEn ?? null),
      plazoGarantiaDias: input.plazoGarantiaDias !== undefined ? input.plazoGarantiaDias : (base?.plazoGarantiaDias ?? null),
      updatedAt: this.now(),
    };
    this.plazos.set(contractId, next);
    this.log(organizationId, contractId, "plazos", contractId, base ? "editar" : "crear", { campos: Object.keys(input).sort() }, actorId);
    return { ...next };
  }

  async setLimiteEntregaPendientes(organizationId: string, contractId: string, fechaLimite: string | null): Promise<number> {
    this.guard();
    let n = 0;
    for (const [id, g] of this.garantias) {
      if (g.organizationId === organizationId && g.contractId === contractId && g.tipo === "cumplimiento" && g.estado === "pendiente_entrega") {
        this.garantias.set(id, { ...g, fechaLimiteEntrega: fechaLimite });
        n += 1;
      }
    }
    return n;
  }

  async listGarantias(organizationId: string, contractId: string): Promise<readonly Garantia[]> {
    this.guard();
    return [...this.garantias.values()].filter((g) => g.organizationId === organizationId && g.contractId === contractId).sort((a, b) => a.vigenciaHasta.localeCompare(b.vigenciaHasta) || a.createdAt.localeCompare(b.createdAt)).map(stripOrg);
  }

  async getGarantia(organizationId: string, id: string): Promise<Garantia | null> {
    this.guard();
    const g = this.garantias.get(id);
    return g && g.organizationId === organizationId ? stripOrg(g) : null;
  }

  async createGarantia(organizationId: string, contractId: string, input: GarantiaCreate, actorId: string): Promise<Garantia> {
    this.guard();
    if ([...this.garantias.values()].filter((g) => g.contractId === contractId).length >= 30) throw new PostAdjudicacionValidationError("Máximo 30 garantías por contrato.");
    const ahora = this.now();
    const g: MemGarantia = {
      organizationId,
      id: randomUUID(),
      contractId,
      tipo: input.tipo,
      monto: fromCents(input.montoCents),
      porcentaje: input.porcentajeBp === null ? null : input.porcentajeBp / 100,
      afianzadora: input.afianzadora,
      numeroPoliza: input.numeroPoliza,
      vigenciaDesde: input.vigenciaDesde,
      vigenciaHasta: input.vigenciaHasta,
      fechaLimiteEntrega: input.fechaLimiteEntrega,
      entregadaEn: input.entregadaEn,
      estado: input.entregadaEn ? "entregada" : "pendiente_entrega",
      notas: input.notas,
      createdAt: ahora,
      updatedAt: ahora,
    };
    this.garantias.set(g.id, g);
    this.log(organizationId, contractId, "garantia", g.id, "crear", { estado: g.estado, tipo: g.tipo }, actorId);
    return stripOrg(g);
  }

  async updateGarantia(organizationId: string, id: string, patch: GarantiaPatch, actor: PostAdjudicacionActor): Promise<Garantia> {
    this.guard();
    const actual = this.garantias.get(id);
    if (!actual || actual.organizationId !== organizationId) throw new PostAdjudicacionNotFoundError("Garantía no encontrada.");
    if (isGarantiaFinal(actual.estado)) throw new PostAdjudicacionStateError(`La garantía ya está ${actual.estado} y no admite más cambios.`);
    if (patch.estado !== undefined && patch.estado !== actual.estado) {
      assertGarantiaTransicion(actual.estado, patch.estado);
      if (GARANTIA_ESTADOS_DE_DECISION.includes(patch.estado) && !actor.canDecide) throw new PostAdjudicacionForbiddenError("Liberar o ejecutar una garantía exige un rol de decisión.");
    }
    const next: MemGarantia = {
      ...actual,
      monto: patch.montoCents !== undefined ? fromCents(patch.montoCents) : actual.monto,
      porcentaje: patch.porcentajeBp !== undefined ? (patch.porcentajeBp === null ? null : patch.porcentajeBp / 100) : actual.porcentaje,
      afianzadora: patch.afianzadora !== undefined ? patch.afianzadora : actual.afianzadora,
      numeroPoliza: patch.numeroPoliza !== undefined ? patch.numeroPoliza : actual.numeroPoliza,
      vigenciaDesde: patch.vigenciaDesde ?? actual.vigenciaDesde,
      vigenciaHasta: patch.vigenciaHasta ?? actual.vigenciaHasta,
      fechaLimiteEntrega: patch.fechaLimiteEntrega !== undefined ? patch.fechaLimiteEntrega : actual.fechaLimiteEntrega,
      entregadaEn: patch.entregadaEn !== undefined ? patch.entregadaEn : actual.entregadaEn,
      estado: patch.estado ?? actual.estado,
      notas: patch.notas !== undefined ? patch.notas : actual.notas,
      updatedAt: this.now(),
    };
    if (next.vigenciaHasta < next.vigenciaDesde) throw new PostAdjudicacionValidationError("vigenciaHasta no puede ser anterior a vigenciaDesde.");
    if ((next.estado === "pendiente_entrega") !== (next.entregadaEn === null)) throw new PostAdjudicacionValidationError("Una garantía entregada necesita su fecha de entrega y una pendiente no puede tenerla.");
    this.garantias.set(id, next);
    this.log(organizationId, actual.contractId, "garantia", id, next.estado !== actual.estado ? "cambio_estado" : "editar", { estado: next.estado, estado_anterior: actual.estado }, actor.userId);
    return stripOrg(next);
  }

  async listHitos(organizationId: string, contractId: string): Promise<readonly Hito[]> {
    this.guard();
    return [...this.hitos.values()].filter((h) => h.organizationId === organizationId && h.contractId === contractId).sort((a, b) => a.fechaCompromiso.localeCompare(b.fechaCompromiso) || a.createdAt.localeCompare(b.createdAt)).map(stripOrg);
  }

  async getHito(organizationId: string, id: string): Promise<Hito | null> {
    this.guard();
    const h = this.hitos.get(id);
    return h && h.organizationId === organizationId ? stripOrg(h) : null;
  }

  private assertResponsable(organizationId: string, userId: string): void {
    if (!(this.responsables[organizationId] ?? []).some((r) => r.userId === userId)) throw new PostAdjudicacionForbiddenError("El responsable debe ser un miembro del equipo de tu organización.");
  }

  async createHito(organizationId: string, contractId: string, input: HitoInput, actorId: string): Promise<Hito> {
    this.guard();
    this.assertResponsable(organizationId, input.responsableId);
    const ahora = this.now();
    const h: MemHito = { organizationId, id: randomUUID(), contractId, titulo: input.titulo, descripcion: input.descripcion, responsableId: input.responsableId, fechaCompromiso: input.fechaCompromiso, estado: "pendiente", cumplidoEn: null, createdAt: ahora, updatedAt: ahora };
    this.hitos.set(h.id, h);
    this.log(organizationId, contractId, "hito", h.id, "crear", { estado: "pendiente" }, actorId);
    return stripOrg(h);
  }

  async updateHito(organizationId: string, id: string, patch: HitoPatch, actor: PostAdjudicacionActor): Promise<Hito> {
    this.guard();
    const actual = this.hitos.get(id);
    if (!actual || actual.organizationId !== organizationId) throw new PostAdjudicacionNotFoundError("Hito no encontrado.");
    if (actual.estado !== "pendiente") throw new PostAdjudicacionStateError(`El hito ya está ${actual.estado} y no admite más cambios.`);
    if (patch.responsableId !== undefined) this.assertResponsable(organizationId, patch.responsableId);
    const next: MemHito = {
      ...actual,
      titulo: patch.titulo ?? actual.titulo,
      descripcion: patch.descripcion !== undefined ? patch.descripcion : actual.descripcion,
      responsableId: patch.responsableId ?? actual.responsableId,
      fechaCompromiso: patch.fechaCompromiso ?? actual.fechaCompromiso,
      estado: patch.estado ?? actual.estado,
      cumplidoEn: patch.cumplidoEn !== undefined ? patch.cumplidoEn : actual.cumplidoEn,
      updatedAt: this.now(),
    };
    this.hitos.set(id, next);
    this.log(organizationId, actual.contractId, "hito", id, next.estado !== actual.estado ? "cambio_estado" : "editar", { estado: next.estado, estado_anterior: actual.estado }, actor.userId);
    return stripOrg(next);
  }

  async listConvenios(organizationId: string, contractId: string): Promise<readonly Convenio[]> {
    this.guard();
    return this.convenios.filter((c) => c.organizationId === organizationId && c.contractId === contractId).sort((a, b) => a.numero - b.numero).map(stripOrg);
  }

  async createConvenio(organizationId: string, contractId: string, input: ConvenioInput, actorId: string, fechaFinAnterior: string | null): Promise<Convenio> {
    this.guard();
    const previos = this.convenios.filter((c) => c.contractId === contractId);
    if (previos.length >= 50) throw new PostAdjudicacionValidationError("Máximo 50 convenios por contrato.");
    const c: MemConvenio = {
      organizationId,
      id: randomUUID(),
      contractId,
      numero: previos.length + 1,
      tipo: input.tipo,
      montoDelta: input.montoDeltaCents === null ? null : fromCents(input.montoDeltaCents),
      nuevaFechaFin: input.nuevaFechaFin,
      fechaFinAnterior,
      fechaFirma: input.fechaFirma,
      motivo: input.motivo,
      createdAt: this.now(),
    };
    this.convenios.push(c);
    this.log(organizationId, contractId, "convenio", c.id, "crear", { tipo: c.tipo }, actorId);
    return stripOrg(c);
  }

  async listBitacora(organizationId: string, contractId: string, limit = 100): Promise<readonly BitacoraEntrada[]> {
    this.guard();
    return this.bitacora
      .filter((b) => b.organizationId === organizationId && b.contractId === contractId)
      .slice()
      .reverse()
      .slice(0, Math.min(Math.max(Math.trunc(limit), 1), 200))
      .map(({ organizationId: _o, contractId: _c, ...rest }) => rest);
  }

  async listResponsables(organizationId: string): Promise<readonly Responsable[]> {
    this.guard();
    return this.responsables[organizationId] ?? [];
  }

  async listAlertCandidates(organizationId: string, hoy: string, ventanaDias: number): Promise<readonly PostAdjudicacionAlertaCandidata[] | null> {
    if (this.unavailable) return null;
    const out: PostAdjudicacionAlertaCandidata[] = [];
    for (const g of this.garantias.values()) {
      if (g.organizationId !== organizationId) continue;
      const v = evaluarGarantia(g, hoy, ventanaDias);
      if (v.porVencer) out.push({ tipo: "garantia_por_vencer", entidadId: g.id, contractId: g.contractId, tenderId: this.contractTenders.get(g.contractId) ?? "", fecha: g.vigenciaHasta });
      if (v.entregaVencida && g.fechaLimiteEntrega) out.push({ tipo: "garantia_no_entregada", entidadId: g.id, contractId: g.contractId, tenderId: this.contractTenders.get(g.contractId) ?? "", fecha: g.fechaLimiteEntrega });
    }
    for (const h of this.hitos.values()) {
      if (h.organizationId === organizationId && evaluarHito(h, hoy).vencido) out.push({ tipo: "hito_vencido", entidadId: h.id, contractId: h.contractId, tenderId: this.contractTenders.get(h.contractId) ?? "", fecha: h.fechaCompromiso });
    }
    return out.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.entidadId.localeCompare(b.entidadId)).slice(0, 200);
  }
}

function stripOrg<T extends { organizationId: string }>(row: T): Omit<T, "organizationId"> {
  const { organizationId: _o, ...rest } = row;
  return rest;
}
