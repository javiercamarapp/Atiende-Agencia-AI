// ═══════════════════════════════════════════════════════════════════════════
// TIMBRADO DE CFDI — puerto del patrón real de
// ~/proyecto-origen/src/lib/saas/facturapi.ts (timbrarMensualidad/cancelarCfdi) y
// ~/proyecto-origen/src/lib/saas/transferencia.ts (timbrarFactura: la reserva
// compare-and-set ANTES de llamar al PAC).
//
// El proveedor concreto (Facturapi, u otro PAC) entra por `PacClient` — el
// motor no llama a ningún PAC directamente, para poder compartirse entre
// verticales que usen proveedores distintos y para poder testear sin red.
//
// DOS INVARIANTES QUE SE PORTAN TAL CUAL DEL ORIGINAL:
//
//   1. NO SE TIMBRA SIN DESGLOSE. `total` es lo que se cobró; el PAC necesita
//      la BASE sin IVA. Si no se sabe cuál de las dos cifras era, no se
//      timbra a ciegas — un CFDI de más o de menos es irreversible sin
//      cancelarlo ante el SAT.
//   2. LA RESERVA ES ANTES DE LLAMAR AL PAC, no después — y es responsabilidad
//      de quien LLAMA a `timbrarFactura`, no de esta función. Dos llamadas
//      concurrentes para la misma factura pasan las dos por "no tiene UUID
//      todavía" si no hay candado, y cada una crea un CFDI REAL. El candado
//      es el mismo compare-and-set que `conciliar()` usa en
//      `rails/transfer-rail.ts` (un UPDATE condicional sobre el store de la
//      app, con una reserva que expira): el llamador debe ganarlo ANTES de
//      invocar esta función, exactamente como el UPDATE condicional con
//      `timbrando_en` del original.
// ═══════════════════════════════════════════════════════════════════════════

import { desgloseCuadra } from '../iva.ts';
import type { DatosFiscalesReceptor } from '../types.ts';

export interface CfdiTimbrado {
  id: string;
  uuid: string;
  urlPdf: string | null;
  urlXml: string | null;
  urlVerificacion: string | null;
  total: number;
}

/** El PAC concreto (Facturapi u otro) — el motor solo conoce esta forma. */
export interface PacClient {
  timbrar(opts: {
    receptor: DatosFiscalesReceptor;
    /** LA BASE, sin IVA. */
    subtotal: number;
    descripcion: string;
    referencia?: string;
  }): Promise<CfdiTimbrado>;
  cancelar(facturaProveedorId: string, motivo: string): Promise<{ estado: string }>;
}

export interface FacturaParaTimbrar {
  id: string;
  total: number;
  subtotal: number | null;
  iva: number | null;
  referencia?: string;
  descripcion: string;
}

/**
 * Timbra una factura YA PAGADA. Lanza `Error` si el desglose no está o no
 * cuadra — nunca intenta adivinar el subtotal a partir del total.
 */
export async function timbrarFactura(
  pac: PacClient,
  factura: FacturaParaTimbrar,
  receptor: DatosFiscalesReceptor,
): Promise<CfdiTimbrado> {
  if (factura.subtotal === null || factura.iva === null) {
    throw new Error(
      `Factura ${factura.id}: no trae el desglose de IVA guardado. No se timbra a ciegas — ` +
      'un CFDI mal emitido es irreversible sin cancelarlo ante el SAT.',
    );
  }
  if (!desgloseCuadra(factura.total, factura.subtotal, factura.iva)) {
    throw new Error(
      `Factura ${factura.id}: subtotal ${factura.subtotal} + IVA ${factura.iva} no da el total ${factura.total} cobrado.`,
    );
  }
  if (!(factura.subtotal > 0)) {
    throw new Error(`Factura ${factura.id}: no se timbra una factura de $0.`);
  }

  const cfdi = await pac.timbrar({
    receptor,
    subtotal: factura.subtotal,
    descripcion: factura.descripcion,
    referencia: factura.referencia,
  });

  if (Math.abs(cfdi.total - factura.total) > 0.01) {
    // El CFDI YA EXISTE ante el SAT en este punto: no se puede deshacer desde
    // aquí. El llamador decide si loguea, alerta o cancela — este módulo solo
    // lo expone en el resultado para que no pase desapercibido.
    (cfdi as CfdiTimbrado & { totalNoCuadraConCobro?: boolean }).totalNoCuadraConCobro = true;
  }

  return cfdi;
}

export const MOTIVO_OPERACION_NO_REALIZADA = '02';

export async function cancelarCfdiDeFactura(
  pac: PacClient,
  facturaProveedorId: string,
  motivo: string = MOTIVO_OPERACION_NO_REALIZADA,
): Promise<{ estado: string }> {
  return pac.cancelar(facturaProveedorId, motivo);
}
