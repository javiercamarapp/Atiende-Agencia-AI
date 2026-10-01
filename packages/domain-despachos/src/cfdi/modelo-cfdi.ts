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

/** Las columnas de impuestos/descuento en centavos solo admiten >= 0 (CHECK de la migración 018): un valor negativo
 * (comprobante con hallazgos, p. ej. IVA < 0) no es representable ahí y se guarda como desconocido (null) -- el CFDI se
 * ingiere igual y el hallazgo ya lo dejó `validarCfdiDespachos`; nunca se convierte en un 500 por un CHECK. */
const noNegativo = (c: number | null): number | null => (c !== null && c < 0 ? null : c);

export function montosCfdiACentavos(m: MontosCfdiEntrada): MontosCfdiCentavos {
  return {
    subtotalCentavos: noNegativo(aCentavos(m.subtotal)) ?? 0,
    descuentoCentavos: noNegativo(aCentavos(m.descuento ?? 0)) ?? 0,
    totalCentavos: aCentavos(m.total)!,
    ivaTrasladadoCentavos: noNegativo(aCentavos(m.iva)),
    isrRetenidoCentavos: noNegativo(aCentavos(m.retencionIsr)),
    ivaRetenidoCentavos: noNegativo(aCentavos(m.retencionIva)),
    iepsCentavos: noNegativo(aCentavos(m.ieps)),
  };
}

export interface CamposPagoCfdi {
  readonly metodoPago: string | null;
  readonly formaPago: string | null;
  readonly usoCfdi: string | null;
  readonly moneda: string | null;
  readonly tipoCambio: number | null;
}

/**
 * Los campos de pago/uso/moneda se persisten SOLO si tienen la forma que exige la base (CHECK, migración 018): PUE/PPD,
 * 2 dígitos, 3-4 alfanuméricos en mayúsculas, ISO 4217 de 3 letras, tipo de cambio > 0 y < 1e9. Un valor que no la cumple
 * (un CFDI con catálogo inválido sigue ingiriéndose con su hallazgo) se guarda como null en vez de provocar un 500.
 */
export function normalizarCamposPagoCfdi(c: { metodoPago?: string | null; formaPago?: string | null; usoCfdi?: string | null; moneda?: string | null; tipoCambio?: number | null }): CamposPagoCfdi {
  const limpio = (v: string | null | undefined): string => (v ?? "").trim().toUpperCase();
  const metodoPago = limpio(c.metodoPago);
  const formaPago = limpio(c.formaPago);
  const usoCfdi = limpio(c.usoCfdi);
  const moneda = limpio(c.moneda);
  const tc = c.tipoCambio;
  return {
    metodoPago: metodoPago === "PUE" || metodoPago === "PPD" ? metodoPago : null,
    formaPago: /^\d{2}$/.test(formaPago) ? formaPago : null,
    usoCfdi: /^[A-Z0-9]{3,4}$/.test(usoCfdi) ? usoCfdi : null,
    moneda: /^[A-Z]{3}$/.test(moneda) ? moneda : null,
    tipoCambio: typeof tc === "number" && Number.isFinite(tc) && tc > 0 && tc < 1e9 ? Math.round(tc * 1e6) / 1e6 : null,
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
