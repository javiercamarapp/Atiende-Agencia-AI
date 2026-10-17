// Reconstruye la DIOT de un período desde los CFDI ya persistidos (`despachos.invoice`),
// sin volver a pedir datos crudos del CFDI. Extraído tal cual de
// `GET /despachos/:propertyId/declaraciones/diot/:periodo` para que esa ruta y los
// reportes de cliente (`reportes/`) compartan UNA sola lectura de la regla y no puedan
// divergir. Puro, sin I/O.
//
// Reglas (heredadas de la ruta, sin cambio):
//  - Solo cuentan los invoices con `diot.reportable` y al menos un proveedor reportable
//    (la DIOT solo reporta operaciones de CFDI tipo "I" con subtotal > 0).
//  - D-P3-01: ademas SOLO cuentan las compras del cliente: `direccion === "recibido"` (los emitidos
//    son sus ventas, no proveedores), estado SAT distinto de `cancelado`/`no_encontrado`,
//    `valido === true` y sin revision rechazada. Un CFDI de direccion desconocida (`null`/ausente,
//    ingerido antes de la migracion 018, o `indeterminado`) solo cuenta si su receptor ES el RFC de la ficha del
//    cliente (compra comprobada contra la ficha, nunca contra otro CFDI); si no, queda fuera y se cuenta en
//    `excluidos`. Asi la base sin migrar sigue produciendo la DIOT de las compras sin colar ventas.
//  - `ivaTrasladado` = `ivaAcreditable` = `invoice.iva` (el propio `ProveedorReportableDiot`
//    ya se construyó así en la Fase 2, sin distinguir traslado/acreditamiento).
//  - `fecha` es `invoice.fecha` (fecha REAL de emisión, migración 006), nunca la de ingesta.
//  - D-P3-01: el RFC del contribuyente sale de la FICHA de cartera (`cartera/ficha.ts`) y se recibe
//    como parametro; NUNCA se deriva de un CFDI. Sin ficha -> `null` y la DIOT queda "sin datos".
import { agregarDiot } from "./diot-aggregate.ts";
import type { InvoiceRecord } from "../types.ts";
import type { DiotAgregado, RegistroDiotCandidato } from "./types.ts";

export type DiotDesdeInvoices = Omit<DiotAgregado, "rfcContribuyente"> & {
  readonly rfcContribuyente: string | null;
  /** Cuantos CFDI reportables se dejaron fuera por no ser una compra valida (emitidos, cancelados, invalidos, rechazados, direccion desconocida). */
  readonly excluidos: number;
};

/** Estados SAT que sacan un CFDI de la DIOT: un comprobante cancelado o que el SAT no encuentra no es una operacion acreditable. */
const ESTADOS_SAT_EXCLUIDOS: ReadonlySet<string> = new Set(["cancelado", "no_encontrado"]);

/** `true` si el invoice es una compra del cliente apta para la DIOT. */
export function esCompraReportableDiot(inv: InvoiceRecord, rfcContribuyente: string | null): boolean {
  if (inv.direccion === "emitido") return false;
  if (inv.direccion !== "recibido") {
    // Direccion desconocida: solo se acepta si la ficha confirma que el cliente es el receptor y no el emisor.
    if (rfcContribuyente === null || inv.rfcReceptor !== rfcContribuyente || inv.rfcEmisor === rfcContribuyente) return false;
  }
  if (inv.estadoSat !== undefined && ESTADOS_SAT_EXCLUIDOS.has(inv.estadoSat)) return false;
  if (inv.valido !== true) return false;
  // TODO(D-P3-23): excluir tambien los invoices con revision "rechazado" cuando el invoice la marque
  // (hoy la revision vive en `invoice_review` y el invoice no la expone); mientras tanto un rechazo humano
  // no saca el CFDI de la DIOT -- limite documentado en el PR.
  return true;
}

/** Candidatos DIOT (un renglon por CFDI reportable) reconstruidos desde los invoices
 * persistidos. Compartido por `construirDiotDesdeInvoices` y por el generador de layout
 * (`diot-layout.ts`) para que ambos lean la MISMA regla y no puedan divergir.
 * `rfcContribuyente` es el de la ficha de cartera (o `null` si el cliente no tiene ficha). */
export function candidatosDiotDesdeInvoices(
  invoices: readonly InvoiceRecord[],
  rfcContribuyente: string | null,
): { readonly candidatos: RegistroDiotCandidato[]; readonly rfcContribuyente: string | null; readonly excluidos: number } {
  const conProveedor = invoices.filter((inv) => inv.diot.reportable && inv.diot.proveedoresReportables.length > 0);
  const reportables = conProveedor.filter((inv) => esCompraReportableDiot(inv, rfcContribuyente));
  const candidatos: RegistroDiotCandidato[] = reportables.map((inv) => {
    const p = inv.diot.proveedoresReportables[0]!;
    return {
      rfcEmisor: inv.rfcEmisor,
      nombreEmisor: inv.emisorNombre ?? p.nombreProveedor,
      subtotal: inv.subtotal,
      ivaTrasladado: inv.iva ?? 0,
      ivaAcreditable: inv.iva ?? 0,
      tasaIva: p.tasaIva ?? (inv.iva != null && inv.subtotal > 0 ? inv.iva / inv.subtotal : 0),
      // Naturaleza real de la operacion, NUNCA derivada de la tasa de IVA — ausente -> "85" (Otros).
      tipoOperacion: p.tipoOperacion ?? null,
      tipoCambio: p.tipoCambio ?? 1,
      moneda: p.moneda ?? "MXN",
      fecha: inv.fecha,
    };
  });
  return { candidatos, rfcContribuyente, excluidos: conProveedor.length - reportables.length };
}

export function construirDiotDesdeInvoices(invoices: readonly InvoiceRecord[], periodo: string, rfcContribuyenteFicha: string | null): DiotDesdeInvoices {
  const { candidatos, rfcContribuyente, excluidos } = candidatosDiotDesdeInvoices(invoices, rfcContribuyenteFicha);
  if (candidatos.length === 0 || rfcContribuyente === null) {
    return { registros: [], totalMontoNeto: 0, totalIvaTrasladado: 0, totalIvaAcreditable: 0, periodo, rfcContribuyente: rfcContribuyente, excluidos };
  }
  return { ...agregarDiot(candidatos, rfcContribuyente, periodo), excluidos };
}
