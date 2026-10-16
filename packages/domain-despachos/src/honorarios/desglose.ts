// D-32 -- desglose de una prefactura de honorarios con aritmetica ENTERA (mitad hacia arriba), identica a la que recalcula la base en
// `despachos.prefactura_generar` (migracion 023): IVA = base * tasa, retencion de ISR = base * tasa, retencion de IVA = 2/3 del IVA.
// Tasa en frontera, retenciones a personas morales y claves SAT: NO VERIFICADO, lista del fiscalista (D-34).
import { desgloseCuadra } from "@atiende/billing";
import { MAX_MONTO_CENTAVOS, MAX_RETENCION_ISR_BP, TASAS_IVA_BP } from "./types.ts";
import type { Desglose, IgualaInput } from "./types.ts";

export class DesgloseInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesgloseInvalidoError";
  }
}

/** round(base * bp / 10000), mitad hacia arriba, sin flotantes. */
export function porcentajeCentavos(baseCentavos: number, bp: number): number {
  return Math.floor((baseCentavos * bp + 5000) / 10000);
}

/** round(iva * 2 / 3), mitad hacia arriba: (4 * iva + 3) / 6 en enteros. */
export function dosTercios(ivaCentavos: number): number {
  return Math.floor((ivaCentavos * 4 + 3) / 6);
}

export function calcularDesglose(i: Pick<IgualaInput, "montoBaseCentavos" | "tasaIvaBp" | "retencionIsrBp" | "retieneIvaDosTercios">): Desglose {
  if (!Number.isSafeInteger(i.montoBaseCentavos) || i.montoBaseCentavos <= 0 || i.montoBaseCentavos > MAX_MONTO_CENTAVOS) {
    throw new DesgloseInvalidoError(`El monto base debe ser un entero de centavos entre 1 y ${MAX_MONTO_CENTAVOS}.`);
  }
  if (!(TASAS_IVA_BP as readonly number[]).includes(i.tasaIvaBp)) throw new DesgloseInvalidoError("La tasa de IVA debe ser 0 %, 8 % o 16 %.");
  if (!Number.isInteger(i.retencionIsrBp) || i.retencionIsrBp < 0 || i.retencionIsrBp > MAX_RETENCION_ISR_BP) throw new DesgloseInvalidoError("La retención de ISR debe estar entre 0 % y 35 %.");
  const ivaCentavos = porcentajeCentavos(i.montoBaseCentavos, i.tasaIvaBp);
  const retencionIsrCentavos = porcentajeCentavos(i.montoBaseCentavos, i.retencionIsrBp);
  const retencionIvaCentavos = i.retieneIvaDosTercios ? dosTercios(ivaCentavos) : 0;
  const totalCentavos = i.montoBaseCentavos + ivaCentavos - retencionIsrCentavos - retencionIvaCentavos;
  if (totalCentavos <= 0) throw new DesgloseInvalidoError("Las retenciones dejan un total a cobrar de $0 o negativo.");
  return { baseCentavos: i.montoBaseCentavos, ivaCentavos, retencionIsrCentavos, retencionIvaCentavos, totalCentavos };
}

/** Importes en PESOS para el puerto del PAC (que habla en pesos): base sin IVA, IVA y total facturado (base + IVA). */
export function importesParaPac(d: Desglose): { subtotal: number; iva: number; total: number } {
  return { subtotal: d.baseCentavos / 100, iva: d.ivaCentavos / 100, total: (d.baseCentavos + d.ivaCentavos) / 100 };
}

export type Timbrabilidad = { readonly ok: true } | { readonly ok: false; readonly codigo: "sin_desglose" | "desglose_no_cuadra" | "retenciones_pendientes_verificar"; readonly mensaje: string };

/**
 * Invariante "no se timbra sin desglose" (el mismo de `timbrarFactura`, antes de reservar): la base, el IVA y el total tienen que cuadrar.
 * Una prefactura con retenciones NO se timbra: el puerto del PAC no transporta retenciones y un CFDI sin ellas no coincide con lo cobrado;
 * queda en la lista del fiscalista (D-34).
 */
export function evaluarTimbrabilidad(d: Desglose): Timbrabilidad {
  if (!(d.baseCentavos > 0) || !Number.isSafeInteger(d.ivaCentavos) || d.ivaCentavos < 0) return { ok: false, codigo: "sin_desglose", mensaje: "La prefactura no trae el desglose de IVA: no se timbra a ciegas." };
  const p = importesParaPac(d);
  if (!desgloseCuadra(p.total, p.subtotal, p.iva) || d.totalCentavos !== d.baseCentavos + d.ivaCentavos - d.retencionIsrCentavos - d.retencionIvaCentavos) {
    return { ok: false, codigo: "desglose_no_cuadra", mensaje: "El desglose de la prefactura no cuadra con su total: no se timbra." };
  }
  if (d.retencionIsrCentavos > 0 || d.retencionIvaCentavos > 0) {
    return { ok: false, codigo: "retenciones_pendientes_verificar", mensaje: "Esta prefactura lleva retenciones y el timbrado con retenciones aún no está verificado por el fiscalista (D-34): no se timbra." };
  }
  return { ok: true };
}
