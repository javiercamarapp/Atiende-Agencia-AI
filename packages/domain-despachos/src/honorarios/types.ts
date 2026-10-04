// D-32 -- tipos de la facturacion de honorarios (igualas y prefacturas). Todo en CENTAVOS ENTEROS (MXN).
export const ESTADOS_PREFACTURA = ["borrador", "aprobada", "timbrando", "timbrada", "cancelada", "fallida"] as const;
export type EstadoPrefactura = (typeof ESTADOS_PREFACTURA)[number];

/** Motivos de cancelacion del SAT. 01 = comprobante emitido con errores CON relacion (exige el folio fiscal que lo sustituye). */
export const MOTIVOS_CANCELACION = ["01", "02", "03", "04"] as const;
export type MotivoCancelacion = (typeof MOTIVOS_CANCELACION)[number];
export const ETIQUETAS_MOTIVO_CANCELACION: Readonly<Record<MotivoCancelacion, string>> = {
  "01": "Comprobante emitido con errores con relación",
  "02": "Comprobante emitido con errores sin relación",
  "03": "No se llevó a cabo la operación",
  "04": "Operación nominativa relacionada en una factura global",
};

/** Tasas de IVA admitidas, en puntos base: 0 % (exento/tasa cero), 8 % (frontera: NO VERIFICADO, D-34) y 16 %. */
export const TASAS_IVA_BP = [0, 800, 1600] as const;
export const MAX_RETENCION_ISR_BP = 3500;
export const MAX_MONTO_CENTAVOS = 100_000_000_000;
export const MAX_IGUALAS_POR_CLIENTE = 50;
/** Una reserva de timbrado vieja (en segundos) puede reclamarse; la base exige >= 300. */
export const EXPIRA_RESERVA_SEGUNDOS = 900;

export interface IgualaInput {
  readonly concepto: string;
  readonly claveProdServ: string;
  readonly claveUnidad: string;
  readonly montoBaseCentavos: number;
  readonly tasaIvaBp: number;
  readonly retencionIsrBp: number;
  /** Retencion de IVA de dos terceras partes del IVA trasladado (persona fisica que factura a persona moral). */
  readonly retieneIvaDosTercios: boolean;
  /** Dia del mes (1-28) en que se programa la emision. */
  readonly diaEmision: number;
  readonly usoCfdi: string;
  readonly activa: boolean;
}

export interface IgualaRecord extends IgualaInput {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  /** `por_verificar` hasta que el fiscalista confirme la clave concreta (D-34). */
  readonly claveSatEstado: "por_verificar" | "verificada";
  readonly periodicidad: "mensual";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Desglose {
  readonly baseCentavos: number;
  readonly ivaCentavos: number;
  readonly retencionIsrCentavos: number;
  readonly retencionIvaCentavos: number;
  /** Lo que se cobra al cliente: base + IVA - retenciones. */
  readonly totalCentavos: number;
}

export interface ReceptorPrefactura {
  readonly rfc: string;
  readonly razonSocial: string;
  readonly regimenFiscal: string;
  readonly codigoPostal: string;
}

export interface PrefacturaRecord extends Desglose {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly igualaId: string;
  readonly periodo: string;
  readonly estado: EstadoPrefactura;
  readonly concepto: string;
  readonly claveProdServ: string;
  readonly claveUnidad: string;
  readonly receptor: ReceptorPrefactura;
  readonly usoCfdi: string;
  readonly fechaEmision: string;
  readonly aprobadaEn: string | null;
  readonly timbrandoEn: string | null;
  readonly timbradaEn: string | null;
  readonly uuid: string | null;
  readonly pacId: string | null;
  readonly urlPdf: string | null;
  readonly urlXml: string | null;
  /** Codigo corto del ultimo fallo (nunca el mensaje crudo del PAC). */
  readonly errorTimbrado: string | null;
  readonly canceladaEn: string | null;
  readonly motivoCancelacion: MotivoCancelacion | null;
  readonly folioSustitucion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TimbreRegistrado {
  readonly uuid: string;
  readonly pacId: string;
  readonly urlPdf: string | null;
  readonly urlXml: string | null;
}

export interface CancelacionDatos {
  readonly motivo: MotivoCancelacion;
  readonly folioSustitucion: string | null;
  /** true solo cuando el PAC ya confirmo la cancelacion de un CFDI timbrado. */
  readonly acusePac: boolean;
}
