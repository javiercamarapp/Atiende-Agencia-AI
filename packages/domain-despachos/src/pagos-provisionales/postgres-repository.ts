// D-25 -- adaptador Postgres de pagos provisionales (migraciones 018 y 020). SAVEPOINT por operación (REGLA DURA): contra la base
// SIN migrar el 42883/42P01/42703 degrada a "no disponible" sin dejar la transacción abortada (25P02).
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { MAX_FACTURAS_PAPEL, PagosDatosInvalidosError, PagosNoDisponiblesError, PagosNoEncontradoError, PagosSinPermisoError, PapelYaPresentadoError } from "./repository.ts";
import type { BasePapel, LecturaPapeles, PagoRepNuevo, PagosProvisionalesRepository, PapelAGuardar, PapelGuardado } from "./repository.ts";
import type { FacturaProvisional, ImpuestoProvisional, PagoRepProvisional } from "./types.ts";

const FN_PREFIX = "despachos.pago_";

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

/** SQLSTATE de las funciones de la migración 020 -> error de dominio. */
export function traducirErrorPagos(err: unknown): unknown {
  const mensaje = err instanceof Error ? err.message.replace(/^(pago_[a-z_]+):\s*/, "") : "Datos inválidos.";
  switch (pgCode(err)) {
    case "42501":
      return new PagosSinPermisoError();
    case "22023":
    case "23514":
      return new PagosDatosInvalidosError(mensaje);
    case "55000":
      return new PapelYaPresentadoError(mensaje);
    case "P0002":
      return new PagosNoEncontradoError(mensaje);
    default:
      return err;
  }
}

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("El monto devuelto por la base excede el rango entero seguro.");
  return n;
};
const numReq = (v: string | number): number => num(v) as number;

interface FacturaRaw {
  id: string;
  folio_fiscal: string;
  tipo: string;
  valido: boolean;
  fecha: string;
  direccion: FacturaProvisional["direccion"];
  metodo_pago: string | null;
  forma_pago: string | null;
  uso_cfdi: string | null;
  moneda: string | null;
  subtotal_centavos: string | null;
  descuento_centavos: string | null;
  total_centavos: string | null;
  iva_trasladado_centavos: string | null;
  isr_retenido_centavos: string | null;
  iva_retenido_centavos: string | null;
  estado_sat: FacturaProvisional["estadoSat"];
}

const FACTURA_COLUMNAS = `i.id, i.folio_fiscal, i.tipo, i.valido, i.fecha::text as fecha, i.direccion, i.metodo_pago, i.forma_pago, i.uso_cfdi, i.moneda,
  i.subtotal_centavos, i.descuento_centavos, i.total_centavos, i.iva_trasladado_centavos, i.isr_retenido_centavos, i.iva_retenido_centavos, i.estado_sat`;

function mapFactura(r: FacturaRaw): FacturaProvisional {
  return {
    id: r.id,
    folioFiscal: r.folio_fiscal,
    tipo: r.tipo,
    valido: r.valido,
    fecha: r.fecha,
    direccion: r.direccion,
    metodoPago: r.metodo_pago,
    formaPago: r.forma_pago,
    usoCfdi: r.uso_cfdi,
    moneda: r.moneda,
    subtotalCentavos: num(r.subtotal_centavos),
    descuentoCentavos: num(r.descuento_centavos),
    totalCentavos: num(r.total_centavos),
    ivaTrasladadoCentavos: num(r.iva_trasladado_centavos),
    isrRetenidoCentavos: num(r.isr_retenido_centavos),
    ivaRetenidoCentavos: num(r.iva_retenido_centavos),
    estadoSat: r.estado_sat,
  };
}

interface PapelRaw {
  id: string;
  ejercicio: number;
  mes: number;
  impuesto: ImpuestoProvisional;
  regimen: string;
  base_centavos: string;
  determinado_centavos: string;
  acreditable_centavos: string;
  a_cargo_centavos: string;
  a_favor_centavos: string;
  parametros: Record<string, unknown>;
  advertencias: number;
  estado: "borrador" | "presentado";
  monto_pagado_centavos: string | null;
  fecha_presentacion: string | null;
  updated_at: string | Date;
}

function mapPapel(r: PapelRaw): PapelGuardado {
  return {
    id: r.id,
    ejercicio: r.ejercicio,
    mes: r.mes,
    impuesto: r.impuesto,
    regimen: r.regimen,
    baseCentavos: numReq(r.base_centavos),
    determinadoCentavos: numReq(r.determinado_centavos),
    acreditableCentavos: numReq(r.acreditable_centavos),
    aCargoCentavos: numReq(r.a_cargo_centavos),
    aFavorCentavos: numReq(r.a_favor_centavos),
    parametros: r.parametros ?? {},
    advertencias: r.advertencias,
    estado: r.estado,
    montoPagadoCentavos: num(r.monto_pagado_centavos),
    fechaPresentacion: r.fecha_presentacion,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export class PostgresPagosProvisionalesRepository implements PagosProvisionalesRepository {
  constructor(private readonly db: TenantDbSession) {}

  async leerBase(propertyId: string, ejercicio: number, mes: number): Promise<BasePapel> {
    const desde = `${ejercicio}-01-01`;
    const hasta = new Date(Date.UTC(ejercicio, mes, 0)).toISOString().slice(0, 10); // último día del mes
    // 1) Pagos de REP (migración 020). Sin ella: sin pagos y sin subconsulta sobre pago_cfdi.
    const pagosLectura = await runWithSavepointFallback<{ disponible: boolean; pagos: PagoRepProvisional[] }>({
      session: this.db,
      savepointName: "sp_pp_pagos",
      primary: async () => {
        const { rows } = await this.db.query<{ invoice_id: string; fecha_pago: string; flujo: "trasladado" | "acreditable"; importe_pagado_centavos: string; base_centavos: string; iva_centavos: string; iva_retenido_centavos: string }>(
          `select invoice_id, fecha_pago::text as fecha_pago, flujo, importe_pagado_centavos, base_centavos, iva_centavos, iva_retenido_centavos
           from despachos.pago_cfdi where property_id = $1 and fecha_pago between $2::date and $3::date order by fecha_pago, id limit $4;`,
          [propertyId, desde, hasta, MAX_FACTURAS_PAPEL],
        );
        return {
          disponible: true,
          pagos: rows.map((r) => ({
            invoiceId: r.invoice_id,
            fechaPago: r.fecha_pago,
            flujo: r.flujo,
            importePagadoCentavos: numReq(r.importe_pagado_centavos),
            baseCentavos: numReq(r.base_centavos),
            ivaCentavos: numReq(r.iva_centavos),
            ivaRetenidoCentavos: numReq(r.iva_retenido_centavos),
          })),
        };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, pagos: [] }),
    });
    // 2) CFDI del ejercicio hasta el mes + los de meses/ejercicios anteriores pagados en el rango.
    const idsConPago = [...new Set(pagosLectura.pagos.map((p) => p.invoiceId))];
    const facturas = await runWithSavepointFallback<{ disponible: boolean; filas: FacturaRaw[] }>({
      session: this.db,
      savepointName: "sp_pp_facturas",
      primary: async () => {
        const { rows } = await this.db.query<FacturaRaw>(
          `select ${FACTURA_COLUMNAS} from despachos.invoice i
           where i.property_id = $1 and ((i.fecha between $2::date and $3::date) or i.id = any($4::uuid[]))
           order by i.fecha, i.id limit $5;`,
          [propertyId, desde, hasta, idsConPago, MAX_FACTURAS_PAPEL + 1],
        );
        return { disponible: true, filas: rows };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ disponible: false, filas: [] }),
    });
    return {
      facturas: facturas.filas.slice(0, MAX_FACTURAS_PAPEL).map(mapFactura),
      pagos: pagosLectura.pagos,
      facturasDisponibles: facturas.disponible,
      pagosDisponibles: pagosLectura.disponible,
      truncado: facturas.filas.length > MAX_FACTURAS_PAPEL,
    };
  }

  async registrarPago(propertyId: string, p: PagoRepNuevo): Promise<boolean> {
    try {
      return await runWithSavepointFallback<boolean>({
        session: this.db,
        savepointName: "sp_pp_registrar_pago",
        primary: async () => {
          const { rows } = await this.db.query<{ pago_cfdi_registrar: boolean }>(
            "select despachos.pago_cfdi_registrar($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11) as pago_cfdi_registrar;",
            [propertyId, p.invoiceId, p.folioFiscalRep, p.pagoIndex, p.fechaPago, p.flujo, p.numParcialidad, p.importePagadoCentavos, p.baseCentavos, p.ivaCentavos, p.ivaRetenidoCentavos],
          );
          return rows[0]?.pago_cfdi_registrar === true;
        },
        isRecoverable: (err) => isMigrationPendingError(err, FN_PREFIX),
        fallback: async () => {
          throw new PagosNoDisponiblesError();
        },
      });
    } catch (err) {
      throw traducirErrorPagos(err);
    }
  }

  listarPapeles(propertyId: string, ejercicio: number): Promise<LecturaPapeles> {
    return runWithSavepointFallback<LecturaPapeles>({
      session: this.db,
      savepointName: "sp_pp_papeles",
      primary: async () => {
        const { rows } = await this.db.query<PapelRaw>(
          `select id, ejercicio, mes, impuesto, regimen, base_centavos, determinado_centavos, acreditable_centavos, a_cargo_centavos, a_favor_centavos, parametros, advertencias,
                  estado, monto_pagado_centavos, fecha_presentacion::text as fecha_presentacion, updated_at
           from despachos.pago_provisional where property_id = $1 and ejercicio = $2 order by mes, impuesto;`,
          [propertyId, ejercicio],
        );
        return { estado: "disponible", papeles: rows.map(mapPapel) };
      },
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => ({ estado: "no_disponible", papeles: [] }),
    });
  }

  async guardarPapel(propertyId: string, p: PapelAGuardar): Promise<void> {
    try {
      await runWithSavepointFallback<void>({
        session: this.db,
        savepointName: "sp_pp_guardar_papel",
        primary: async () => {
          await this.db.query("select despachos.pago_provisional_guardar($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12);", [
            propertyId, p.ejercicio, p.mes, p.impuesto, p.regimen, p.baseCentavos, p.determinadoCentavos, p.acreditableCentavos, p.aCargoCentavos, p.aFavorCentavos, JSON.stringify(p.parametros), p.advertencias,
          ]);
        },
        isRecoverable: (err) => isMigrationPendingError(err, FN_PREFIX),
        fallback: async () => {
          throw new PagosNoDisponiblesError();
        },
      });
    } catch (err) {
      throw traducirErrorPagos(err);
    }
  }

  async presentarPapel(propertyId: string, ejercicio: number, mes: number, impuesto: ImpuestoProvisional, montoPagadoCentavos: number, fechaPresentacion: string): Promise<void> {
    try {
      await runWithSavepointFallback<void>({
        session: this.db,
        savepointName: "sp_pp_presentar_papel",
        primary: async () => {
          await this.db.query("select despachos.pago_provisional_presentar($1, $2, $3, $4, $5, $6::date);", [propertyId, ejercicio, mes, impuesto, montoPagadoCentavos, fechaPresentacion]);
        },
        isRecoverable: (err) => isMigrationPendingError(err, FN_PREFIX),
        fallback: async () => {
          throw new PagosNoDisponiblesError();
        },
      });
    } catch (err) {
      throw traducirErrorPagos(err);
    }
  }
}
