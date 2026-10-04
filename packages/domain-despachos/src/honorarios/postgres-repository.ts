// D-32 -- adaptador Postgres de honorarios (migracion 023). SAVEPOINT por operacion (REGLA DURA): contra la base SIN migrar el
// 42883/42P01/42703 degrada a "no disponible" sin dejar la transaccion abortada (25P02).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import {
  HonorariosDatosInvalidosError,
  HonorariosDuplicadoError,
  HonorariosEstadoInvalidoError,
  HonorariosNoDisponiblesError,
  HonorariosNoEncontradoError,
  HonorariosSinPermisoError,
  HonorariosTopeExcedidoError,
} from "./repository.ts";
import type { HonorariosRepository, LecturaIgualas, LecturaPrefacturas } from "./repository.ts";
import type { CancelacionDatos, Desglose, EstadoPrefactura, IgualaInput, IgualaRecord, MotivoCancelacion, PrefacturaRecord, TimbreRegistrado } from "./types.ts";

/** Migracion pendiente: tabla/columna inexistente, o una funcion `despachos.iguala_*` / `despachos.prefactura_*` que todavia no existe. */
const migracionPendiente = (err: unknown): boolean => {
  if (!isMigrationPendingError(err)) return false;
  if (pgCode(err) !== "42883") return true;
  return /despachos\.(iguala|prefactura)_/.test(err instanceof Error ? err.message : "");
};

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** SQLSTATE de las funciones de la migracion 023 -> error de dominio (el mensaje de la base no lleva detalles internos). */
export function traducirErrorHonorarios(err: unknown): unknown {
  const mensaje = err instanceof Error ? err.message.replace(/^((iguala|prefactura)_[a-z_]+):\s*/, "") : "Datos inválidos.";
  switch (pgCode(err)) {
    case "42501":
      return new HonorariosSinPermisoError();
    case "22023":
      return new HonorariosDatosInvalidosError(mensaje);
    case "23514":
      return new HonorariosTopeExcedidoError(mensaje);
    case "23505":
      return new HonorariosDuplicadoError();
    case "55000":
      return new HonorariosEstadoInvalidoError(mensaje);
    case "P0002":
      return new HonorariosNoEncontradoError(mensaje);
    default:
      return err;
  }
}

const num = (v: string | number): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("El monto devuelto por la base excede el rango entero seguro.");
  return n;
};
const iso = (v: string | Date | null): string | null => (v === null ? null : v instanceof Date ? v.toISOString() : String(v));

interface IgualaRaw {
  id: string;
  property_id: string;
  organization_id: string;
  concepto: string;
  clave_prod_serv: string;
  clave_unidad: string;
  clave_sat_estado: "por_verificar" | "verificada";
  monto_base_centavos: string;
  tasa_iva_bp: number;
  retencion_isr_bp: number;
  retiene_iva_dos_tercios: boolean;
  dia_emision: number;
  uso_cfdi: string;
  activa: boolean;
  created_at: string | Date;
  updated_at: string | Date;
}
const IGUALA_COLUMNAS = `id, property_id, organization_id, concepto, clave_prod_serv, clave_unidad, clave_sat_estado, monto_base_centavos, tasa_iva_bp, retencion_isr_bp,
  retiene_iva_dos_tercios, dia_emision, uso_cfdi, activa, created_at, updated_at`;

function mapIguala(r: IgualaRaw): IgualaRecord {
  return {
    id: r.id,
    propertyId: r.property_id,
    organizationId: r.organization_id,
    concepto: r.concepto,
    claveProdServ: r.clave_prod_serv,
    claveUnidad: r.clave_unidad,
    claveSatEstado: r.clave_sat_estado,
    periodicidad: "mensual",
    montoBaseCentavos: num(r.monto_base_centavos),
    tasaIvaBp: r.tasa_iva_bp,
    retencionIsrBp: r.retencion_isr_bp,
    retieneIvaDosTercios: r.retiene_iva_dos_tercios,
    diaEmision: r.dia_emision,
    usoCfdi: r.uso_cfdi,
    activa: r.activa,
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

interface PrefacturaRaw {
  id: string;
  property_id: string;
  organization_id: string;
  iguala_id: string;
  periodo: string;
  estado: EstadoPrefactura;
  concepto: string;
  clave_prod_serv: string;
  clave_unidad: string;
  receptor_rfc: string;
  receptor_razon_social: string;
  receptor_regimen: string;
  receptor_cp: string;
  uso_cfdi: string;
  fecha_emision: string;
  base_centavos: string;
  iva_centavos: string;
  retencion_isr_centavos: string;
  retencion_iva_centavos: string;
  total_centavos: string;
  aprobada_en: string | Date | null;
  timbrando_en: string | Date | null;
  timbrada_en: string | Date | null;
  uuid_cfdi: string | null;
  pac_id: string | null;
  url_pdf: string | null;
  url_xml: string | null;
  error_timbrado: string | null;
  cancelada_en: string | Date | null;
  motivo_cancelacion: MotivoCancelacion | null;
  folio_sustitucion: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}
const PREFACTURA_COLUMNAS = `id, property_id, organization_id, iguala_id, periodo, estado, concepto, clave_prod_serv, clave_unidad, receptor_rfc, receptor_razon_social, receptor_regimen,
  receptor_cp, uso_cfdi, fecha_emision::text as fecha_emision, base_centavos, iva_centavos, retencion_isr_centavos, retencion_iva_centavos, total_centavos, aprobada_en, timbrando_en,
  timbrada_en, uuid_cfdi, pac_id, url_pdf, url_xml, error_timbrado, cancelada_en, motivo_cancelacion, folio_sustitucion, created_at, updated_at`;

function mapPrefactura(r: PrefacturaRaw): PrefacturaRecord {
  return {
    id: r.id,
    propertyId: r.property_id,
    organizationId: r.organization_id,
    igualaId: r.iguala_id,
    periodo: r.periodo,
    estado: r.estado,
    concepto: r.concepto,
    claveProdServ: r.clave_prod_serv,
    claveUnidad: r.clave_unidad,
    receptor: { rfc: r.receptor_rfc, razonSocial: r.receptor_razon_social, regimenFiscal: r.receptor_regimen, codigoPostal: r.receptor_cp },
    usoCfdi: r.uso_cfdi,
    fechaEmision: r.fecha_emision,
    baseCentavos: num(r.base_centavos),
    ivaCentavos: num(r.iva_centavos),
    retencionIsrCentavos: num(r.retencion_isr_centavos),
    retencionIvaCentavos: num(r.retencion_iva_centavos),
    totalCentavos: num(r.total_centavos),
    aprobadaEn: iso(r.aprobada_en),
    timbrandoEn: iso(r.timbrando_en),
    timbradaEn: iso(r.timbrada_en),
    uuid: r.uuid_cfdi,
    pacId: r.pac_id,
    urlPdf: r.url_pdf,
    urlXml: r.url_xml,
    errorTimbrado: r.error_timbrado,
    canceladaEn: iso(r.cancelada_en),
    motivoCancelacion: r.motivo_cancelacion,
    folioSustitucion: r.folio_sustitucion,
    createdAt: iso(r.created_at) ?? "",
    updatedAt: iso(r.updated_at) ?? "",
  };
}

export class PostgresHonorariosRepository implements HonorariosRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Una funcion de escritura de la 023 dentro de su SAVEPOINT: base sin migrar -> `HonorariosNoDisponiblesError`; SQLSTATE de la funcion -> error de dominio. */
  private async escribir<T>(savepointName: string, primary: () => Promise<T>): Promise<T> {
    try {
      return await runWithSavepointFallback<T>({
        session: this.db,
        savepointName,
        primary,
        isRecoverable: migracionPendiente,
        fallback: async () => {
          throw new HonorariosNoDisponiblesError();
        },
      });
    } catch (err) {
      throw traducirErrorHonorarios(err);
    }
  }

  listarIgualas(propertyId: string): Promise<LecturaIgualas> {
    return runWithSavepointFallback<LecturaIgualas>({
      session: this.db,
      savepointName: "sp_hon_igualas",
      primary: async () => {
        const { rows } = await this.db.query<IgualaRaw>(`select ${IGUALA_COLUMNAS} from despachos.iguala where property_id = $1 order by created_at, id limit 200;`, [propertyId]);
        return { estado: "disponible", igualas: rows.map(mapIguala) };
      },
      isRecoverable: migracionPendiente,
      fallback: async () => ({ estado: "no_disponible", igualas: [] }),
    });
  }

  guardarIguala(propertyId: string, id: string | null, i: IgualaInput): Promise<string> {
    return this.escribir("sp_hon_iguala_guardar", async () => {
      const { rows } = await this.db.query<{ iguala_guardar: string }>(
        "select despachos.iguala_guardar($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as iguala_guardar;",
        [propertyId, id, i.concepto, i.claveProdServ, i.claveUnidad, i.montoBaseCentavos, i.tasaIvaBp, i.retencionIsrBp, i.retieneIvaDosTercios, i.diaEmision, i.usoCfdi, i.activa],
      );
      return rows[0]!.iguala_guardar;
    });
  }

  eliminarIguala(propertyId: string, id: string): Promise<void> {
    return this.escribir("sp_hon_iguala_eliminar", async () => {
      await this.db.query("select despachos.iguala_eliminar($1, $2);", [propertyId, id]);
    });
  }

  listarPrefacturas(propertyId: string, periodo: string | null): Promise<LecturaPrefacturas> {
    return runWithSavepointFallback<LecturaPrefacturas>({
      session: this.db,
      savepointName: "sp_hon_prefacturas",
      primary: async () => {
        const { rows } = await this.db.query<PrefacturaRaw>(
          `select ${PREFACTURA_COLUMNAS} from despachos.prefactura where property_id = $1 and ($2::text is null or periodo = $2) order by periodo desc, created_at, id limit 500;`,
          [propertyId, periodo],
        );
        return { estado: "disponible", prefacturas: rows.map(mapPrefactura) };
      },
      isRecoverable: migracionPendiente,
      fallback: async () => ({ estado: "no_disponible", prefacturas: [] }),
    });
  }

  obtenerPrefactura(propertyId: string, id: string): Promise<PrefacturaRecord | null> {
    return runWithSavepointFallback<PrefacturaRecord | null>({
      session: this.db,
      savepointName: "sp_hon_prefactura",
      primary: async () => {
        const { rows } = await this.db.query<PrefacturaRaw>(`select ${PREFACTURA_COLUMNAS} from despachos.prefactura where property_id = $1 and id = $2;`, [propertyId, id]);
        return rows[0] ? mapPrefactura(rows[0]) : null;
      },
      isRecoverable: migracionPendiente,
      // Una lectura puntual previa a una escritura: sin la migracion es "no disponible" (503), no "no existe" (404).
      fallback: async () => {
        throw new HonorariosNoDisponiblesError();
      },
    });
  }

  generarPrefactura(propertyId: string, igualaId: string, periodo: string, d: Desglose): Promise<string | null> {
    return this.escribir("sp_hon_prefactura_generar", async () => {
      const { rows } = await this.db.query<{ prefactura_generar: string | null }>(
        "select despachos.prefactura_generar($1, $2, $3, $4, $5, $6, $7, $8) as prefactura_generar;",
        [propertyId, igualaId, periodo, d.baseCentavos, d.ivaCentavos, d.retencionIsrCentavos, d.retencionIvaCentavos, d.totalCentavos],
      );
      return rows[0]?.prefactura_generar ?? null;
    });
  }

  aprobar(propertyId: string, id: string): Promise<void> {
    return this.escribir("sp_hon_prefactura_aprobar", async () => {
      await this.db.query("select despachos.prefactura_aprobar($1, $2);", [propertyId, id]);
    });
  }

  reservarTimbrado(propertyId: string, id: string, expiraSegundos: number): Promise<boolean> {
    return this.escribir("sp_hon_prefactura_reservar", async () => {
      const { rows } = await this.db.query<{ prefactura_reservar_timbrado: boolean }>("select despachos.prefactura_reservar_timbrado($1, $2, $3) as prefactura_reservar_timbrado;", [propertyId, id, expiraSegundos]);
      return rows[0]?.prefactura_reservar_timbrado === true;
    });
  }

  registrarTimbre(propertyId: string, id: string, t: TimbreRegistrado): Promise<void> {
    return this.escribir("sp_hon_prefactura_timbre", async () => {
      await this.db.query("select despachos.prefactura_registrar_timbre($1, $2, $3, $4, $5, $6);", [propertyId, id, t.uuid, t.pacId, t.urlPdf, t.urlXml]);
    });
  }

  registrarFallo(propertyId: string, id: string, codigo: string): Promise<void> {
    return this.escribir("sp_hon_prefactura_fallo", async () => {
      await this.db.query("select despachos.prefactura_registrar_fallo($1, $2, $3);", [propertyId, id, codigo]);
    });
  }

  cancelar(propertyId: string, id: string, d: CancelacionDatos): Promise<void> {
    return this.escribir("sp_hon_prefactura_cancelar", async () => {
      await this.db.query("select despachos.prefactura_cancelar($1, $2, $3, $4, $5);", [propertyId, id, d.motivo, d.folioSustitucion, d.acusePac]);
    });
  }
}
