// D-25 -- de un complemento de pago YA analizado (D-23) a los pagos que se persisten. Puro. La base y el IVA se derivan de la
// factura persistida (no de lo que mande el cliente): base = (subtotal - descuento) x pagado / total, mitad hacia arriba.
import type { AnalisisRep } from "../cfdi/rep.ts";
import { proporcionCentavos } from "../cfdi/rep.ts";
import type { PagoRepNuevo } from "./repository.ts";

export interface FacturaParaPago {
  readonly id: string;
  readonly subtotalCentavos: number;
  readonly descuentoCentavos: number;
  readonly totalCentavos: number;
}

export interface PagoOmitido {
  readonly idDocumento: string;
  readonly motivo: string;
}

export interface PreparacionPagosRep {
  readonly aRegistrar: readonly PagoRepNuevo[];
  readonly omitidos: readonly PagoOmitido[];
}

export function prepararPagosDesdeRep(analisis: AnalisisRep, facturasPorFolio: ReadonlyMap<string, FacturaParaPago>): PreparacionPagosRep {
  const aRegistrar: PagoRepNuevo[] = [];
  const omitidos: PagoOmitido[] = [];
  for (const d of analisis.documentos) {
    const omitir = (motivo: string): void => {
      omitidos.push({ idDocumento: d.idDocumento, motivo });
    };
    const factura = facturasPorFolio.get(d.idDocumento);
    if (!d.ligado || !factura) { omitir("El CFDI pagado no está en este cliente: súbelo antes de registrar el pago."); continue; }
    if (!d.incluidoEnTotales) { omitir("Documento en moneda distinta de MXN: no se registra (no se inventa un tipo de cambio)."); continue; }
    if (d.facturaEsPpd !== true) { omitir("El CFDI no es PPD (o su método de pago no está registrado): solo un PPD se paga con complemento."); continue; }
    if (!d.saldoCoherente) { omitir("El saldo insoluto del complemento no es saldo anterior menos pagado: revisa el complemento."); continue; }
    if (d.impPagadoCentavos <= 0) { omitir("ImpPagado debe ser mayor a cero."); continue; }
    if (d.ivaCentavos === null) { omitir("No hay IVA del pago (ni en el complemento ni en el CFDI ligado)."); continue; }
    const fechaPago = d.fechaPago.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) { omitir("Fecha de pago inválida."); continue; }
    if (factura.totalCentavos <= 0) { omitir("El CFDI no tiene total positivo."); continue; }
    const baseFactura = factura.subtotalCentavos - factura.descuentoCentavos;
    aRegistrar.push({
      invoiceId: factura.id,
      folioFiscalRep: analisis.folioFiscalRep,
      pagoIndex: d.pagoIndex,
      fechaPago,
      flujo: analisis.flujo,
      numParcialidad: d.numParcialidad >= 1 ? d.numParcialidad : null,
      importePagadoCentavos: d.impPagadoCentavos,
      baseCentavos: proporcionCentavos(Math.max(0, baseFactura), d.impPagadoCentavos, factura.totalCentavos),
      ivaCentavos: d.ivaCentavos,
      ivaRetenidoCentavos: d.ivaRetenidoCentavos,
    });
  }
  return { aRegistrar, omitidos };
}
