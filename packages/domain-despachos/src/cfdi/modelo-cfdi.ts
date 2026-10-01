// D-22 -- modelo CFDI completo persistido: dirección (emitido vs recibido según el RFC del cliente del
// despacho), montos en CENTAVOS ENTEROS y desglose de impuestos. Puro: sin I/O, sin SAT, sin PAC.
import type { CfdiXmlImpuesto } from "@atiende/billing";

export type DireccionCfdi = "emitido" | "recibido" | "indeterminado";
export type EstadoSatCfdi = "pendiente" | "vigente" | "cancelado" | "no_encontrado";
export const ESTADOS_SAT_CFDI: readonly EstadoSatCfdi[] = ["pendiente", "vigente", "cancelado", "no_encontrado"];

export function esEstadoSatCfdi(valor: unknown): valor is EstadoSatCfdi {
  return typeof valor === "string" && (ESTADOS_SAT_CFDI as readonly string[]).includes(valor);
}

const normalizarRfc = (valor: string | null | undefined): string => (valor ?? "").trim().toUpperCase();

/**
 * Un CFDI es EMITIDO si el emisor es el cliente del despacho (ingreso: sus ventas, su nómina) y RECIBIDO si el
 * receptor lo es (gasto/compra). Un comprobante entre el cliente y él mismo (p. ej. nómina propia) cuenta como
 * emitido. Si el cliente no tiene ficha (RFC desconocido) o el comprobante no lo involucra, es `indeterminado`:
 * nunca se adivina un sentido, porque un CFDI mal clasificado contamina IVA acreditable y DIOT.
 */
export function clasificarDireccionCfdi(rfcCliente: string | null | undefined, rfcEmisor: string, rfcReceptor: string): DireccionCfdi {
  const cliente = normalizarRfc(rfcCliente);
  if (cliente === "") return "indeterminado";
  if (normalizarRfc(rfcEmisor) === cliente) return "emitido";
  if (normalizarRfc(rfcReceptor) === cliente) return "recibido";
  return "indeterminado";
}

export class MontoInvalidoError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = "MontoInvalidoError";
  }
}

/**
 * Pesos -> centavos enteros. `number`: se redondea a 2 decimales (mitad hacia arriba) corrigiendo el error binario
 * (1.005 * 100 = 100.49999999999999). `string`: decimal exacto ("1234.5678" -> 123457) sin pasar por flotantes.
 * `null/undefined` -> null (monto desconocido, jamás 0). Lanza MontoInvalidoError ante NaN/Infinity/ruido o montos
 * fuera del rango entero seguro.
 */
export function aCentavos(valor: number | string | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) throw new MontoInvalidoError("El monto no es un número finito.");
    const centavos = Math.round(Number((Math.abs(valor) * 100).toPrecision(14))) * Math.sign(valor);
    if (!Number.isSafeInteger(centavos)) throw new MontoInvalidoError("El monto excede el rango permitido.");
    return centavos === 0 ? 0 : centavos;
  }
  const m = /^(-?)(\d{1,15})(?:\.(\d+))?$/.exec(valor.trim());
  if (!m) throw new MontoInvalidoError(`El monto '${valor}' no es un decimal válido.`);
  const decimales = (m[3] ?? "").padEnd(3, "0");
  let centavos = BigInt(m[2]!) * 100n + BigInt(decimales.slice(0, 2));
  if (decimales.charCodeAt(2) >= 53) centavos += 1n; // '5'..'9' en el tercer decimal: mitad hacia arriba
  const con_signo = m[1] === "-" ? -centavos : centavos;
  if (con_signo > BigInt(Number.MAX_SAFE_INTEGER) || con_signo < -BigInt(Number.MAX_SAFE_INTEGER)) throw new MontoInvalidoError("El monto excede el rango permitido.");
  return Number(con_signo);
}

export interface MontosCfdiEntrada {
  readonly subtotal: number;
  readonly total: number;
  readonly descuento?: number | null;
  readonly iva?: number | null;
  readonly retencionIsr?: number | null;
  readonly retencionIva?: number | null;
  readonly ieps?: number | null;
}

export interface MontosCfdiCentavos {
  readonly subtotalCentavos: number;
  readonly descuentoCentavos: number;
  readonly totalCentavos: number;
  readonly ivaTrasladadoCentavos: number | null;
  readonly isrRetenidoCentavos: number | null;
  readonly ivaRetenidoCentavos: number | null;
  readonly iepsCentavos: number | null;
}

export function montosCfdiACentavos(m: MontosCfdiEntrada): MontosCfdiCentavos {
  return {
    subtotalCentavos: aCentavos(m.subtotal)!,
    descuentoCentavos: aCentavos(m.descuento ?? 0)!,
    totalCentavos: aCentavos(m.total)!,
    ivaTrasladadoCentavos: aCentavos(m.iva),
    isrRetenidoCentavos: aCentavos(m.retencionIsr),
    ivaRetenidoCentavos: aCentavos(m.retencionIva),
    iepsCentavos: aCentavos(m.ieps),
  };
}

export type NaturalezaImpuesto = "traslado" | "retencion";
export type TipoFactorImpuesto = "Tasa" | "Cuota" | "Exento";

export interface ImpuestoCfdiInput {
  readonly naturaleza: NaturalezaImpuesto;
  /** c_Impuesto: 001 ISR, 002 IVA, 003 IEPS. */
  readonly impuesto: string;
  readonly tipoFactor: TipoFactorImpuesto;
  /** Tasa/cuota con 6 decimales ("0.160000"); null si es Exento. */
  readonly tasaOCuota: string | null;
  readonly baseCentavos: number | null;
  readonly importeCentavos: number | null;
}

export interface ImpuestoCfdiRecord extends ImpuestoCfdiInput {
  /** Nombre legible del impuesto (ISR/IVA/IEPS). */
  readonly nombre: string;
}

export const NOMBRE_IMPUESTO: Readonly<Record<string, string>> = { "001": "ISR", "002": "IVA", "003": "IEPS" };

/** Desglose del parser (sumas decimales exactas) -> renglones persistibles en centavos. */
export function impuestosDesdeXml(lista: readonly CfdiXmlImpuesto[]): readonly ImpuestoCfdiInput[] {
  return lista.map((i) => ({
    naturaleza: i.naturaleza,
    impuesto: i.impuesto,
    tipoFactor: i.tipoFactor,
    tasaOCuota: i.tasaOCuota,
    baseCentavos: aCentavos(i.base),
    importeCentavos: aCentavos(i.importe),
  }));
}
