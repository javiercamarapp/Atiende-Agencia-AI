// D-P3-14 -- adaptador Postgres del puerto de sistema de las pólizas del periodo (funciones `system_*` de la migración 026). Cada operación corre bajo
// `runWithSavepointFallback`; contra la base sin migrar la lectura devuelve `null` (no disponible) y la escritura lanza `PolizasPeriodoNoDisponibleError`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { PolizasPeriodoNoDisponibleError } from "./polizas-periodo.ts";
import type { CandidatoPolizaSistema, EstadoRegistroSistema, PolizasPeriodoRepository, RegistroPolizaSistema } from "./polizas-periodo.ts";
import type { CuentaLibro, PolizaInput } from "./types.ts";

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const fechaIso = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

interface CandidatoRaw {
  out_organization_id: string;
  out_property_id: string;
  out_invoice_id: string;
  out_folio_fiscal: string;
  out_tipo: string;
  out_direccion: "emitido" | "recibido";
  out_fecha: string | Date;
  out_moneda: string | null;
  out_estado_sat: string;
  out_subtotal_centavos: string | number | null;
  out_descuento_centavos: string | number | null;
  out_total_centavos: string | number | null;
  out_iva_trasladado_centavos: string | number | null;
  out_isr_retenido_centavos: string | number | null;
  out_iva_retenido_centavos: string | number | null;
  out_ieps_centavos: string | number | null;
  out_categoria: string;
  out_cuenta: string | null;
}

export class PostgresPolizasPeriodoRepository implements PolizasPeriodoRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listarCandidatos(desde: string, hasta: string, limite: number): Promise<readonly CandidatoPolizaSistema[] | null> {
    return runWithSavepointFallback<readonly CandidatoPolizaSistema[] | null>({
      session: this.db,
      savepointName: "sp_cron_polizas_candidatos",
      primary: async () => {
        const { rows } = await this.db.query<CandidatoRaw>("select * from despachos.system_polizas_periodo_candidatos($1::date, $2::date, $3);", [desde, hasta, limite]);
        return rows.map((r) => ({
          organizationId: r.out_organization_id,
          propertyId: r.out_property_id,
          invoiceId: r.out_invoice_id,
          folioFiscal: r.out_folio_fiscal,
          tipo: r.out_tipo,
          direccion: r.out_direccion,
          fecha: fechaIso(r.out_fecha),
          moneda: r.out_moneda,
          estadoSat: r.out_estado_sat,
          subtotalCentavos: num(r.out_subtotal_centavos),
          descuentoCentavos: num(r.out_descuento_centavos),
          totalCentavos: num(r.out_total_centavos),
          ivaTrasladadoCentavos: num(r.out_iva_trasladado_centavos),
          isrRetenidoCentavos: num(r.out_isr_retenido_centavos),
          ivaRetenidoCentavos: num(r.out_iva_retenido_centavos),
          iepsCentavos: num(r.out_ieps_centavos),
          categoria: r.out_categoria,
          cuenta: r.out_cuenta,
        }));
      },
      isRecoverable: (err) => isMigrationPendingError(err, "system_polizas_periodo_candidatos"),
      fallback: async () => null,
    });
  }

  async registrarPolizaSistema(propertyId: string, invoiceId: string, poliza: PolizaInput, catalogo: readonly CuentaLibro[]): Promise<RegistroPolizaSistema> {
    const movimientos = poliza.movimientos.map((m) => ({ cuenta: m.cuenta, concepto: m.concepto, debe: m.debeCentavos, haber: m.haberCentavos }));
    const cuentas = catalogo.map((c) => ({ codigo: c.codigo, descripcion: c.descripcion, naturaleza: c.naturaleza }));
    return runWithSavepointFallback<RegistroPolizaSistema>({
      session: this.db,
      savepointName: "sp_cron_poliza_registrar",
      primary: async () => {
        const { rows } = await this.db.query<{ out_estado: EstadoRegistroSistema; out_poliza_id: string | null; out_folio: number | null }>(
          "select * from despachos.system_poliza_cfdi_registrar($1, $2, $3, $4::date, $5, $6::jsonb, $7::jsonb);",
          [propertyId, invoiceId, poliza.tipo, poliza.fecha, poliza.concepto, JSON.stringify(movimientos), JSON.stringify(cuentas)],
        );
        const r = rows[0]!;
        return { estado: r.out_estado, polizaId: r.out_poliza_id, folio: r.out_folio === null ? null : Number(r.out_folio) };
      },
      isRecoverable: (err) => isMigrationPendingError(err, "system_poliza_cfdi_registrar"),
      fallback: async () => {
        throw new PolizasPeriodoNoDisponibleError();
      },
    });
  }
}
