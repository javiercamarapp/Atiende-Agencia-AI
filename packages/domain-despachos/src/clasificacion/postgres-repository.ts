// D-P3-13 -- adaptador Postgres de la clasificación contable (migración 026). Cada operación corre bajo `runWithSavepointFallback`: la sesión es UNA
// transacción compartida por request y un error de Postgres la deja abortada (25P02). Contra la base SIN migrar el 42883/42P01/42703 degrada a
// "no disponible" (lecturas: vacío honesto + estado) o a `ClasificacionNoDisponibleError` (escrituras); nunca a un 500.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "../bookkeeping/confianza.ts";
import {
  ClasificacionDatosInvalidosError,
  ClasificacionNoDisponibleError,
  ClasificacionNoEncontradaError,
  ClasificacionSinPermisoError,
  ClasificacionTopeExcedidoError,
} from "./types.ts";
import type { ClasificacionAEscribir, ClasificacionRecord, ClasificacionRepository, ConfigClasificacion, CorreccionInput, CorreccionRecord, LecturaClasificacion, MetodoClasificacionRegistrado } from "./types.ts";

const MAX_HISTORIAL = 50;
const MAX_CORRECCIONES = 1000;

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** SQLSTATE de las funciones de la migración 026 -> error de dominio tipado (sin filtrar más detalle de Postgres del necesario). */
export function traducirErrorClasificacion(err: unknown): unknown {
  const mensaje = err instanceof Error ? err.message.replace(/^[a-z_]+:\s*/, "") : "Datos inválidos.";
  switch (pgCode(err)) {
    case "42501":
      return new ClasificacionSinPermisoError();
    case "22023":
    case "23514":
      return new ClasificacionDatosInvalidosError(mensaje);
    case "P0002":
      return new ClasificacionNoEncontradaError();
    case "54000":
      return new ClasificacionTopeExcedidoError(mensaje);
    default:
      return err;
  }
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

interface ClasificacionRaw {
  id: string;
  invoice_id: string;
  categoria: string;
  confianza: string | number | null;
  method: MetodoClasificacionRegistrado;
  razon: string | null;
  cuenta: string | null;
  empate: boolean;
  classified_by: string | null;
  created_at: string | Date;
}

function mapClasificacion(r: ClasificacionRaw): ClasificacionRecord {
  return {
    id: r.id,
    invoiceId: r.invoice_id,
    categoria: r.categoria,
    confianza: r.confianza === null ? null : Number(r.confianza),
    metodo: r.method,
    razon: r.razon,
    cuenta: r.cuenta,
    empate: r.empate,
    clasificadaPor: r.classified_by,
    creadaEn: iso(r.created_at),
  };
}

const COLUMNAS_CLASIFICACION = "c.id, c.invoice_id, c.categoria, c.confianza::text as confianza, c.method, c.razon, c.cuenta, c.empate, c.classified_by, c.created_at";

export class PostgresClasificacionRepository implements ClasificacionRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Lectura con degradación honesta contra la base sin migrar. */
  private async leer<T>(savepointName: string, vacio: T, primary: () => Promise<T>): Promise<LecturaClasificacion<T>> {
    return runWithSavepointFallback<LecturaClasificacion<T>>({
      session: this.db,
      savepointName,
      primary: async () => ({ estado: "ok", datos: await primary() }),
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ estado: "no_disponible", datos: vacio }),
    });
  }

  /** Escritura: contra la base sin migrar, `ClasificacionNoDisponibleError`; los SQLSTATE de las funciones definer se traducen. */
  private async escribir<T>(savepointName: string, funcion: string | undefined, primary: () => Promise<T>): Promise<T> {
    try {
      return await runWithSavepointFallback<T>({
        session: this.db,
        savepointName,
        primary,
        // Con `funcion`, un 42883 solo cuenta como "migración pendiente" si el mensaje nombra ESA función (no una interna distinta: eso sería un bug real).
        isRecoverable: (err) => isMigrationPendingError(err, funcion),
        fallback: () => Promise.reject(new ClasificacionNoDisponibleError()),
      });
    } catch (err) {
      throw traducirErrorClasificacion(err);
    }
  }

  async registrar(propertyId: string, invoiceId: string, r: ClasificacionAEscribir): Promise<boolean> {
    try {
      return await runWithSavepointFallback<boolean>({
        session: this.db,
        savepointName: "sp_despachos_clasificar_invoice",
        primary: async () => {
          await this.db.query(`select despachos.invoice_clasificar($1, $2, $3, $4, $5, $6, $7, $8);`, [propertyId, invoiceId, r.categoria, r.confianza, r.metodo, r.razon, r.cuenta, r.empate]);
          return true;
        },
        isRecoverable: (err) => isMigrationPendingError(err, "invoice_clasificar"),
        fallback: async () => false,
      });
    } catch (err) {
      throw traducirErrorClasificacion(err);
    }
  }

  async corregirCategoria(propertyId: string, invoiceId: string, input: { readonly categoria: string; readonly cuenta: string | null; readonly guardarRegla: boolean }): Promise<string> {
    return this.escribir("sp_despachos_categoria_corregir", "invoice_categoria_corregir", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select despachos.invoice_categoria_corregir($1, $2, $3, $4, $5) as id;`, [propertyId, invoiceId, input.categoria, input.cuenta, input.guardarRegla]);
      return rows[0]!.id;
    });
  }

  async vigentes(propertyId: string, invoiceIds: readonly string[]): Promise<LecturaClasificacion<ReadonlyMap<string, ClasificacionRecord>>> {
    if (invoiceIds.length === 0) return { estado: "ok", datos: new Map() };
    return this.leer<ReadonlyMap<string, ClasificacionRecord>>("sp_despachos_clasificacion_vigente", new Map(), async () => {
      const { rows } = await this.db.query<ClasificacionRaw>(
        `select distinct on (c.invoice_id) ${COLUMNAS_CLASIFICACION}
           from despachos.invoice_classification c
          where c.property_id = $1 and c.invoice_id = any($2::uuid[])
          order by c.invoice_id, c.created_at desc, c.id desc;`,
        [propertyId, [...invoiceIds]],
      );
      return new Map(rows.map((r) => [r.invoice_id, mapClasificacion(r)]));
    });
  }

  async historial(propertyId: string, invoiceId: string): Promise<LecturaClasificacion<readonly ClasificacionRecord[]>> {
    return this.leer<readonly ClasificacionRecord[]>("sp_despachos_clasificacion_historial", [], async () => {
      const { rows } = await this.db.query<ClasificacionRaw>(
        `select ${COLUMNAS_CLASIFICACION}
           from despachos.invoice_classification c
          where c.property_id = $1 and c.invoice_id = $2
          order by c.created_at desc, c.id desc
          limit ${MAX_HISTORIAL};`,
        [propertyId, invoiceId],
      );
      return rows.map(mapClasificacion);
    });
  }

  async listarCorrecciones(propertyId: string): Promise<LecturaClasificacion<readonly CorreccionRecord[]>> {
    return this.leer<readonly CorreccionRecord[]>("sp_despachos_clasificacion_correcciones", [], async () => {
      const { rows } = await this.db.query<{ id: string; rfc_emisor: string; clave_prod_serv: string | null; categoria: string; cuenta: string | null; autor_id: string | null; created_at: string | Date; updated_at: string | Date }>(
        `select id, rfc_emisor, clave_prod_serv, categoria, cuenta, autor_id, created_at, updated_at
           from despachos.clasificacion_correccion where property_id = $1
          order by rfc_emisor, clave_prod_serv nulls first limit ${MAX_CORRECCIONES};`,
        [propertyId],
      );
      return rows.map((r) => ({ id: r.id, rfcEmisor: r.rfc_emisor, claveProdServ: r.clave_prod_serv, categoria: r.categoria, cuenta: r.cuenta, autorId: r.autor_id, creadaEn: iso(r.created_at), actualizadaEn: iso(r.updated_at) }));
    });
  }

  async guardarCorreccion(propertyId: string, input: CorreccionInput): Promise<string> {
    return this.escribir("sp_despachos_correccion_guardar", "clasificacion_correccion_guardar", async () => {
      const { rows } = await this.db.query<{ id: string }>(`select despachos.clasificacion_correccion_guardar($1, $2, $3, $4, $5) as id;`, [propertyId, input.rfcEmisor, input.claveProdServ, input.categoria, input.cuenta]);
      return rows[0]!.id;
    });
  }

  async eliminarCorreccion(propertyId: string, id: string): Promise<boolean> {
    return this.escribir("sp_despachos_correccion_eliminar", "clasificacion_correccion_eliminar", async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select despachos.clasificacion_correccion_eliminar($1, $2) as ok;`, [propertyId, id]);
      return rows[0]!.ok === true;
    });
  }

  async leerConfig(propertyId: string): Promise<ConfigClasificacion> {
    const porOmision: ConfigClasificacion = { umbral: DEFAULT_CONFIDENCE_THRESHOLD, portalAutoaceptar: true, disponible: true };
    return runWithSavepointFallback<ConfigClasificacion>({
      session: this.db,
      savepointName: "sp_despachos_clasificacion_config",
      primary: async () => {
        const { rows } = await this.db.query<{ umbral: string; autoaceptar: boolean }>(
          `select clasificacion_umbral_confianza::text as umbral, portal_autoaceptar_validos as autoaceptar from despachos.property_config where property_id = $1;`,
          [propertyId],
        );
        const fila = rows[0];
        return fila ? { umbral: Number(fila.umbral), portalAutoaceptar: fila.autoaceptar, disponible: true } : porOmision;
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ ...porOmision, disponible: false }),
    });
  }

  async guardarConfig(propertyId: string, organizationId: string, cambios: { readonly umbral?: number; readonly portalAutoaceptar?: boolean }): Promise<ConfigClasificacion> {
    const guardada = await this.escribir("sp_despachos_clasificacion_config_guardar", undefined, async () => {
      const { rows } = await this.db.query<{ umbral: string; autoaceptar: boolean }>(
        `insert into despachos.property_config (property_id, organization_id, clasificacion_umbral_confianza, portal_autoaceptar_validos)
         values ($1, $2, coalesce($3::numeric, 0.7), coalesce($4::boolean, true))
         on conflict (property_id) do update set
           clasificacion_umbral_confianza = coalesce($3::numeric, despachos.property_config.clasificacion_umbral_confianza),
           portal_autoaceptar_validos = coalesce($4::boolean, despachos.property_config.portal_autoaceptar_validos),
           updated_at = now()
         returning clasificacion_umbral_confianza::text as umbral, portal_autoaceptar_validos as autoaceptar;`,
        [propertyId, organizationId, cambios.umbral ?? null, cambios.portalAutoaceptar ?? null],
      );
      return rows[0]!;
    });
    return { umbral: Number(guardada.umbral), portalAutoaceptar: guardada.autoaceptar, disponible: true };
  }

  async recalcularDireccion(propertyId: string): Promise<number | null> {
    try {
      return await runWithSavepointFallback<number | null>({
        session: this.db,
        savepointName: "sp_despachos_direccion_recalcular",
        primary: async () => {
          const { rows } = await this.db.query<{ n: number }>(`select despachos.invoice_direccion_recalcular($1) as n;`, [propertyId]);
          return Number(rows[0]!.n);
        },
        isRecoverable: (err) => isMigrationPendingError(err, "invoice_direccion_recalcular"),
        fallback: async () => null,
      });
    } catch (err) {
      throw traducirErrorClasificacion(err);
    }
  }
}
