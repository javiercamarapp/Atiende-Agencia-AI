// L-08 -- almacenamiento del KYC 69-B de licitaciones (tablas/funciones de la migracion 031).
// Modulo APARTE de `repository.ts`/`postgres-repository.ts` (mismo criterio que
// `whatsapp-repository.ts`: archivos compartidos por varias ramas en paralelo).
//
// REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la API se despliega antes que la
// migracion 031 (y la lista 69-B vive en la migracion 014 de despachos). Cada operacion corre
// dentro de `runWithSavepointFallback` (SAVEPOINT / ROLLBACK TO SAVEPOINT) porque la sesion
// del request es UNA transaccion: un 42P01/42703/42883 sin savepoint la dejaria abortada
// (25P02) y el COMMIT revertiria todo en silencio. Si falta la migracion se lanza
// `KycNotAvailableError`; el llamador decide: lecturas -> "no disponible aun", escrituras -> 503.
// Nunca un 500.
//
// Los errores de negocio que la base lanza a proposito (22023 entrada invalida, 54000 tope,
// 23505 ficha duplicada) NO son "migracion pendiente": se propagan como errores tipados.
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  KYC_MAX_PARTIES,
  KycNotAvailableError,
  KycRateLimitError,
  KycValidationError,
  armarConsultaResultado,
  armarFichasResultado,
  isKycRole,
  isKycSituacion,
  parseRfcBatch,
} from "./kyc-69b.ts";
import type { Kyc69bSituacion, KycConsultaFila, KycConsultaResultado, KycFicha, KycFichasResultado, KycRole } from "./kyc-69b.ts";

export interface KycListaEstado {
  readonly periodo: string;
  readonly filas: number;
  readonly ingestadoEn: string;
}

export interface KycConsultaBitacora {
  readonly id: string;
  readonly userId: string | null;
  readonly loteId: string;
  readonly rfc: string;
  readonly encontrado: boolean;
  readonly situacion: Kyc69bSituacion | null;
  readonly periodo: string | null;
  readonly consultadoEn: string;
}

export interface KycFichaInput {
  readonly rfc: string;
  readonly rol: KycRole;
  readonly nombre: string;
}

export interface Kyc69bRepository {
  /** Consulta un RFC o un lote (<= 50) contra la edicion vigente y lo registra en la bitacora de la organizacion. */
  consultar(organizationId: string, rfcs: readonly string[]): Promise<KycConsultaResultado>;
  /** `null` = nunca se ingirio la lista. */
  estadoLista(): Promise<KycListaEstado | null>;
  listFichas(organizationId: string): Promise<KycFichasResultado>;
  addFicha(organizationId: string, input: KycFichaInput): Promise<{ readonly id: string }>;
  removeFicha(organizationId: string, id: string): Promise<boolean>;
  /** Bitacora privada de la organizacion (la lee el rol de decision; RLS lo refuerza). */
  listConsultas(organizationId: string, limit?: number): Promise<readonly KycConsultaBitacora[]>;
}

function dbCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function dbMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/** Traduce los SQLSTATE de negocio que la base lanza a proposito a errores tipados. El resto se repropaga. */
function mapBusinessError(err: unknown): never {
  const code = dbCode(err);
  if (code === "22023") {
    const msg = dbMessage(err).replace(/^kyc_[a-z0-9_]+:\s*/i, "");
    throw new KycValidationError(msg || "Entrada invalida.");
  }
  if (code === "54000") {
    if (/fichas/i.test(dbMessage(err))) throw new KycValidationError(`Maximo ${KYC_MAX_PARTIES} fichas por organizacion.`);
    throw new KycRateLimitError();
  }
  if (code === "23505") throw new KycValidationError("Ese RFC ya esta registrado con ese rol.");
  throw err;
}

interface ConsultaRow {
  out_rfc: string;
  out_encontrado: boolean;
  out_periodo: string | null;
  out_nombre: string | null;
  out_situacion: string | null;
  out_oficio_presuncion: string | null;
  out_fecha_publicacion: string | null;
  out_fecha_presuncion_sat: string | null;
  out_fecha_desvirtuado_sat: string | null;
  out_fecha_definitivo_sat: string | null;
  out_fecha_sentencia_favorable_sat: string | null;
}

function mapConsulta(r: ConsultaRow): KycConsultaFila {
  return {
    rfc: r.out_rfc,
    encontrado: r.out_encontrado,
    periodo: r.out_periodo,
    nombre: r.out_nombre || null,
    situacion: isKycSituacion(r.out_situacion) ? r.out_situacion : null,
    oficioPresuncion: r.out_oficio_presuncion,
    fechaPublicacion: r.out_fecha_publicacion,
    fechaPresuncionSat: r.out_fecha_presuncion_sat,
    fechaDesvirtuadoSat: r.out_fecha_desvirtuado_sat,
    fechaDefinitivoSat: r.out_fecha_definitivo_sat,
    fechaSentenciaFavorableSat: r.out_fecha_sentencia_favorable_sat,
  };
}

interface FichaRow {
  out_id: string;
  out_rfc: string;
  out_rol: string;
  out_nombre: string;
  out_creada_en: string;
  out_periodo: string | null;
  out_encontrado: boolean;
  out_situacion: string | null;
  out_fecha_publicacion: string | null;
}

function mapFicha(r: FichaRow): KycFicha {
  return {
    id: r.out_id,
    rfc: r.out_rfc,
    rol: isKycRole(r.out_rol) ? r.out_rol : "proveedor",
    nombre: r.out_nombre,
    creadaEn: r.out_creada_en,
    periodo: r.out_periodo,
    encontrado: r.out_encontrado,
    situacion: isKycSituacion(r.out_situacion) ? r.out_situacion : null,
    fechaPublicacion: r.out_fecha_publicacion,
  };
}

export class PostgresKyc69bRepository implements Kyc69bRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** `primary` en un SAVEPOINT; base sin migrar (42P01/42703/42883) -> `KycNotAvailableError` con la sesion ya recuperada. */
  private guarded<T>(primary: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      primary,
      isRecoverable: isMigrationPendingError,
      fallback: async () => {
        throw new KycNotAvailableError();
      },
    });
  }

  async consultar(organizationId: string, rfcs: readonly string[]): Promise<KycConsultaResultado> {
    // Defensa en profundidad: la API ya valida, pero este repositorio nunca manda un lote sin normalizar a la base.
    const lote = parseRfcBatch([...rfcs]);
    try {
      const rows = await this.guarded(async () => {
        const { rows } = await this.db.query<ConsultaRow>(`select * from licitaciones.kyc_consultar_69b($1::uuid, $2::text[]);`, [organizationId, lote]);
        return rows;
      });
      return armarConsultaResultado(rows.map(mapConsulta));
    } catch (err) {
      return mapBusinessError(err);
    }
  }

  async estadoLista(): Promise<KycListaEstado | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ out_periodo: string; out_filas: number; out_ingestado_en: string }>(`select * from licitaciones.kyc_estado_lista();`);
      const r = rows[0];
      return r ? { periodo: r.out_periodo, filas: Number(r.out_filas), ingestadoEn: r.out_ingestado_en } : null;
    });
  }

  async listFichas(organizationId: string): Promise<KycFichasResultado> {
    const rows = await this.guarded(async () => {
      const { rows } = await this.db.query<FichaRow>(`select * from licitaciones.kyc_fichas_con_situacion($1::uuid);`, [organizationId]);
      return rows;
    });
    return armarFichasResultado(rows.map(mapFicha));
  }

  async addFicha(organizationId: string, input: KycFichaInput): Promise<{ readonly id: string }> {
    try {
      return await this.guarded(async () => {
        const { rows } = await this.db.query<{ id: string }>(
          `insert into licitaciones.kyc_party (organization_id, rfc, rol, nombre) values ($1, $2, $3, $4) returning id;`,
          [organizationId, input.rfc, input.rol, input.nombre],
        );
        return { id: rows[0]!.id };
      });
    } catch (err) {
      return mapBusinessError(err);
    }
  }

  async removeFicha(organizationId: string, id: string): Promise<boolean> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ id: string }>(`delete from licitaciones.kyc_party where organization_id = $1 and id = $2 returning id;`, [organizationId, id]);
      return rows.length > 0;
    });
  }

  async listConsultas(organizationId: string, limit = 50): Promise<readonly KycConsultaBitacora[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.guarded(async () => {
      const { rows } = await this.db.query<{
        id: string;
        user_id: string | null;
        lote_id: string;
        rfc: string;
        encontrado: boolean;
        situacion: string | null;
        periodo: string | null;
        consultado_en: string;
      }>(
        `select id, user_id, lote_id, rfc, encontrado, situacion, periodo, consultado_en::text as consultado_en
           from licitaciones.kyc_consulta where organization_id = $1 order by consultado_en desc, id desc limit $2;`,
        [organizationId, capped],
      );
      return rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        loteId: r.lote_id,
        rfc: r.rfc,
        encontrado: r.encontrado,
        situacion: isKycSituacion(r.situacion) ? r.situacion : null,
        periodo: r.periodo,
        consultadoEn: r.consultado_en,
      }));
    });
  }
}

// ---------------------------------------------------------------------------
// En memoria (tests de API/web y desarrollo sin base). Reproduce las reglas de la base:
// bitacora por organizacion, tope diario, tope de fichas, unicidad y edicion vigente.
// ---------------------------------------------------------------------------

export interface KycListaFixtureFila {
  readonly rfc: string;
  readonly nombre?: string;
  readonly situacion: Kyc69bSituacion;
  readonly oficioPresuncion?: string | null;
  readonly fechaPresuncionSat?: string | null;
  readonly fechaDesvirtuadoSat?: string | null;
  readonly fechaDefinitivoSat?: string | null;
  readonly fechaSentenciaFavorableSat?: string | null;
}

export interface KycListaFixture {
  readonly periodo: string;
  readonly filas: readonly KycListaFixtureFila[];
}

const DAILY_CAP = 1000;

function fechaPublicacion(f: KycListaFixtureFila): string | null {
  switch (f.situacion) {
    case "presunto":
      return f.fechaPresuncionSat ?? null;
    case "desvirtuado":
      return f.fechaDesvirtuadoSat ?? null;
    case "definitivo":
      return f.fechaDefinitivoSat ?? null;
    case "sentencia_favorable":
      return f.fechaSentenciaFavorableSat ?? null;
  }
}

export class InMemoryKyc69bRepository implements Kyc69bRepository {
  private readonly parties = new Map<string, { id: string; organizationId: string; rfc: string; rol: KycRole; nombre: string; creadaEn: string }>();
  private readonly bitacora: (KycConsultaBitacora & { organizationId: string; ts: number })[] = [];
  /** Identidad del actor (la base la toma de auth.uid()). */
  constructor(
    private readonly lista: KycListaFixture | null,
    private readonly actorUserId: string | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  private situacionDe(rfc: string): KycListaFixtureFila | null {
    return this.lista?.filas.find((f) => f.rfc === rfc) ?? null;
  }

  async consultar(organizationId: string, rfcs: readonly string[]): Promise<KycConsultaResultado> {
    const lote = parseRfcBatch([...rfcs]);
    const ts = this.now();
    const usadas = this.bitacora.filter((b) => b.organizationId === organizationId && b.ts > ts - 24 * 3600 * 1000).length;
    if (usadas + lote.length > DAILY_CAP) throw new KycRateLimitError();
    const loteId = randomUUID();
    const filas = lote.map((rfc): KycConsultaFila => {
      const f = this.situacionDe(rfc);
      this.bitacora.push({
        id: randomUUID(),
        organizationId,
        userId: this.actorUserId,
        loteId,
        rfc,
        encontrado: f !== null,
        situacion: f?.situacion ?? null,
        periodo: this.lista?.periodo ?? null,
        consultadoEn: new Date(ts).toISOString(),
        ts,
      });
      return {
        rfc,
        encontrado: f !== null,
        periodo: this.lista?.periodo ?? null,
        nombre: f?.nombre ?? null,
        situacion: f?.situacion ?? null,
        oficioPresuncion: f?.oficioPresuncion ?? null,
        fechaPublicacion: f ? fechaPublicacion(f) : null,
        fechaPresuncionSat: f?.fechaPresuncionSat ?? null,
        fechaDesvirtuadoSat: f?.fechaDesvirtuadoSat ?? null,
        fechaDefinitivoSat: f?.fechaDefinitivoSat ?? null,
        fechaSentenciaFavorableSat: f?.fechaSentenciaFavorableSat ?? null,
      };
    });
    return armarConsultaResultado(filas);
  }

  async estadoLista(): Promise<KycListaEstado | null> {
    return this.lista ? { periodo: this.lista.periodo, filas: this.lista.filas.length, ingestadoEn: "2024-06-30T00:00:00.000Z" } : null;
  }

  async listFichas(organizationId: string): Promise<KycFichasResultado> {
    const fichas = [...this.parties.values()]
      .filter((p) => p.organizationId === organizationId)
      .map((p): KycFicha => {
        const f = this.situacionDe(p.rfc);
        return {
          id: p.id,
          rfc: p.rfc,
          rol: p.rol,
          nombre: p.nombre,
          creadaEn: p.creadaEn,
          periodo: this.lista?.periodo ?? null,
          encontrado: f !== null,
          situacion: f?.situacion ?? null,
          fechaPublicacion: f ? fechaPublicacion(f) : null,
        };
      });
    return armarFichasResultado(fichas);
  }

  async addFicha(organizationId: string, input: KycFichaInput): Promise<{ readonly id: string }> {
    const delOrg = [...this.parties.values()].filter((p) => p.organizationId === organizationId);
    if (delOrg.some((p) => p.rfc === input.rfc && p.rol === input.rol)) throw new KycValidationError("Ese RFC ya esta registrado con ese rol.");
    if (delOrg.length >= KYC_MAX_PARTIES) throw new KycValidationError(`Maximo ${KYC_MAX_PARTIES} fichas por organizacion.`);
    const id = randomUUID();
    this.parties.set(id, { id, organizationId, rfc: input.rfc, rol: input.rol, nombre: input.nombre, creadaEn: new Date(this.now()).toISOString() });
    return { id };
  }

  async removeFicha(organizationId: string, id: string): Promise<boolean> {
    const p = this.parties.get(id);
    if (!p || p.organizationId !== organizationId) return false;
    this.parties.delete(id);
    return true;
  }

  async listConsultas(organizationId: string, limit = 50): Promise<readonly KycConsultaBitacora[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.bitacora
      .filter((b) => b.organizationId === organizationId)
      .slice()
      .reverse()
      .slice(0, capped)
      .map(({ organizationId: _o, ts: _t, ...rest }) => rest);
  }
}
