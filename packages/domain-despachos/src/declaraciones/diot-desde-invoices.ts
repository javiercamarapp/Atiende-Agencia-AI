// Reconstruye la DIOT de un período desde los CFDI ya persistidos (`despachos.invoice`),
// sin volver a pedir datos crudos del CFDI. Extraído tal cual de
// `GET /despachos/:propertyId/declaraciones/diot/:periodo` para que esa ruta y los
// reportes de cliente (`reportes/`) compartan UNA sola lectura de la regla y no puedan
// divergir. Puro, sin I/O.
//
// Reglas (heredadas de la ruta, sin cambio):
//  - Solo cuentan los invoices con `diot.reportable` y al menos un proveedor reportable
//    (la DIOT solo reporta operaciones de CFDI tipo "I" con subtotal > 0).
//  - `ivaTrasladado` = `ivaAcreditable` = `invoice.iva` (el propio `ProveedorReportableDiot`
//    ya se construyó así en la Fase 2, sin distinguir traslado/acreditamiento).
//  - `fecha` es `invoice.fecha` (fecha REAL de emisión, migración 006), nunca la de ingesta.
//  - El RFC del contribuyente es el `rfcReceptor` del primer invoice reportable.
import { agregarDiot } from "./diot-aggregate.ts";
import type { InvoiceRecord } from "../types.ts";
import type { DiotAgregado, RegistroDiotCandidato } from "./types.ts";

export type DiotDesdeInvoices = Omit<DiotAgregado, "rfcContribuyente"> & { readonly rfcContribuyente: string | null };

/** Candidatos DIOT (un renglón por CFDI reportable) reconstruidos desde los invoices
 * persistidos. Compartido por `construirDiotDesdeInvoices` y por el generador de layout
 * (`diot-layout.ts`) para que ambos lean la MISMA regla y no puedan divergir. */
export function candidatosDiotDesdeInvoices(invoices: readonly InvoiceRecord[]): { readonly candidatos: RegistroDiotCandidato[]; readonly rfcContribuyente: string | null } {
  const reportables = invoices.filter((inv) => inv.diot.reportable && inv.diot.proveedoresReportables.length > 0);
  const candidatos: RegistroDiotCandidato[] = reportables.map((inv) => {
    const p = inv.diot.proveedoresReportables[0]!;
    return {
      rfcEmisor: inv.rfcEmisor,
      nombreEmisor: inv.emisorNombre ?? p.nombreProveedor,
      subtotal: inv.subtotal,
      ivaTrasladado: inv.iva ?? 0,
      ivaAcreditable: inv.iva ?? 0,
      tasaIva: p.tasaIva ?? (inv.iva != null && inv.subtotal > 0 ? inv.iva / inv.subtotal : 0),
      // Naturaleza real de la operación, NUNCA derivada de la tasa de IVA — ausente -> "85" (Otros).
      tipoOperacion: p.tipoOperacion ?? null,
      tipoCambio: p.tipoCambio ?? 1,
      moneda: p.moneda ?? "MXN",
      fecha: inv.fecha,
    };
  });
  return { candidatos, rfcContribuyente: reportables[0]?.rfcReceptor ?? null };
}

export function construirDiotDesdeInvoices(invoices: readonly InvoiceRecord[], periodo: string): DiotDesdeInvoices {
  const { candidatos, rfcContribuyente } = candidatosDiotDesdeInvoices(invoices);
  if (candidatos.length === 0 || rfcContribuyente === null) {
    return { registros: [], totalMontoNeto: 0, totalIvaTrasladado: 0, totalIvaAcreditable: 0, periodo, rfcContribuyente: null };
  }
  return agregarDiot(candidatos, rfcContribuyente, periodo);
}
