// D-25 -- tipos del papel de trabajo de pagos provisionales de ISR e IVA. Todo en CENTAVOS ENTEROS. Puro: sin I/O, sin SAT/PAC.
// La base es el CFDI emitido/recibido persistido (D-22) y los pagos del complemento de pago 2.0 persistidos (D-23, migración 020).
import type { EstadoSatCfdi } from "../cfdi/modelo-cfdi.ts";

export type ImpuestoProvisional = "ISR" | "IVA";
export const IMPUESTOS_PROVISIONALES: readonly ImpuestoProvisional[] = ["ISR", "IVA"];

/** Regímenes con papel de ISR modelado: 601 General de Ley PM (coeficiente de utilidad), 612 PF con actividades empresariales y
 * profesionales (tarifa acumulada), 626 RESICO PF (tasa mensual sobre ingresos cobrados). Otros regímenes: "no soportado" (honesto). */
export const REGIMENES_ISR_SOPORTADOS = ["601", "612", "626"] as const;
export type RegimenIsrSoportado = (typeof REGIMENES_ISR_SOPORTADOS)[number];
export function esRegimenIsrSoportado(valor: string): valor is RegimenIsrSoportado {
  return (REGIMENES_ISR_SOPORTADOS as readonly string[]).includes(valor);
}

/** Lo mínimo que el papel necesita de un CFDI persistido (los montos en centavos son opcionales: null = ingerido antes de D-22). */
export interface FacturaProvisional {
  readonly id: string;
  readonly folioFiscal: string;
  readonly tipo: string;
  readonly valido: boolean;
  /** YYYY-MM-DD de emisión. */
  readonly fecha: string;
  readonly direccion: "emitido" | "recibido" | "indeterminado" | null;
  readonly metodoPago: string | null;
  readonly formaPago: string | null;
  readonly usoCfdi: string | null;
  readonly moneda: string | null;
  readonly subtotalCentavos: number | null;
  readonly descuentoCentavos: number | null;
  readonly totalCentavos: number | null;
  readonly ivaTrasladadoCentavos: number | null;
  readonly isrRetenidoCentavos: number | null;
  readonly ivaRetenidoCentavos: number | null;
  readonly estadoSat: EstadoSatCfdi | null;
}

/** Pago de un CFDI PPD tomado del complemento de pago (tabla `pago_cfdi`). */
export interface PagoRepProvisional {
  readonly invoiceId: string;
  /** YYYY-MM-DD. */
  readonly fechaPago: string;
  readonly flujo: "trasladado" | "acreditable";
  readonly importePagadoCentavos: number;
  readonly baseCentavos: number;
  readonly ivaCentavos: number;
  readonly ivaRetenidoCentavos: number;
}

export interface ParametrosPapelIsr {
  /** Coeficiente de utilidad (art. 14 LISR) como decimal con hasta 6 decimales, p. ej. "0.234567". Solo régimen 601. */
  readonly coeficienteUtilidad?: string | null;
  /** Pérdidas fiscales pendientes de amortizar (centavos). 601 y 612. */
  readonly perdidasPendientesCentavos?: number | null;
  /** Pagos provisionales de ISR de meses anteriores NO capturados en Atiende (centavos). Se suman a los papeles presentados. */
  readonly ajustePagosPreviosCentavos?: number | null;
}

export interface ParametrosPapelIva {
  /** Saldo a favor de IVA de meses anteriores que no sale de un papel presentado en Atiende (centavos). */
  readonly saldoFavorAnteriorCentavos?: number | null;
  /** D-P3-06: valor de los actos o actividades GRAVADOS (16 % y 0 %) del mes, en centavos. Si se omite y hay exentos, se toma la base de los CFDI emitidos del mes. */
  readonly actosGravadosCentavos?: number | null;
  /** D-P3-06: valor de los actos o actividades EXENTOS del mes (centavos). Sin este dato (null/0) el IVA se acredita al 100 % y el papel lo advierte. */
  readonly actosExentosCentavos?: number | null;
}

export interface EntradaPapel {
  readonly ejercicio: number;
  /** 1-12. */
  readonly mes: number;
  readonly regimen: string;
  /** RFC del contribuyente: 12 caracteres = persona moral, 13 = persona física. Define a quién aplican el 612 y el 626 (solo PF). */
  readonly rfc?: string | null;
  /** CFDI del ejercicio hasta el mes (inclusive); el motor filtra por fecha. */
  readonly facturas: readonly FacturaProvisional[];
  readonly pagos: readonly PagoRepProvisional[];
  /** false = la migración 020 no está aplicada: los CFDI PPD no se pueden contar y se advierte. */
  readonly pagosDisponibles: boolean;
  readonly isr: ParametrosPapelIsr;
  readonly iva: ParametrosPapelIva;
  /** Suma de `monto_pagado` de los papeles de ISR PRESENTADOS de meses anteriores del ejercicio. */
  readonly pagosPreviosIsrPresentadosCentavos: number;
  /** a_favor de IVA del papel PRESENTADO del mes anterior (null si no hay). */
  readonly saldoFavorIvaMesAnteriorCentavos: number | null;
}

export interface LineaPapel {
  readonly clave: string;
  readonly concepto: string;
  readonly centavos: number;
  /** Cómo se obtuvo, para el revisor (sin PII). */
  readonly detalle?: string;
}

export interface ExclusionPapel {
  readonly motivo: string;
  readonly cantidad: number;
  readonly importeCentavos: number;
}

export type EstadoCalculo = "calculado" | "no_soportado" | "faltan_parametros";

export interface ResultadoImpuesto {
  readonly impuesto: ImpuestoProvisional;
  readonly estado: EstadoCalculo;
  /** Motivo legible cuando el estado no es "calculado". */
  readonly motivo: string | null;
  readonly lineas: readonly LineaPapel[];
  /** Base gravable (ISR) o IVA trasladado (IVA) -- lo que se guarda en `base_centavos`. */
  readonly baseCentavos: number;
  readonly determinadoCentavos: number;
  readonly acreditableCentavos: number;
  readonly aCargoCentavos: number;
  readonly aFavorCentavos: number;
}

export interface PapelProvisional {
  readonly ejercicio: number;
  readonly mes: number;
  readonly regimen: string;
  readonly isr: ResultadoImpuesto;
  readonly iva: ResultadoImpuesto;
  readonly documentosIncluidos: number;
  readonly exclusiones: readonly ExclusionPapel[];
  /** CFDI PPD del periodo sin complemento de pago registrado: aún no son flujo de efectivo. */
  readonly pendientesPpd: { readonly cantidad: number; readonly importeCentavos: number };
  readonly advertencias: readonly string[];
}
