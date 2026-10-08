// ═══════════════════════════════════════════════════════════════════════════
// ANÁLISIS DEL COMPLEMENTO DE PAGO 2.0 (REP) — D-23. Puro y determinista: sin base de datos, sin red, sin SAT/PAC.
// Recibe el REP ya parseado (`parseComplementoPagoXml` de @atiende/billing) y las facturas que el despacho tiene
// persistidas (para ligar `DoctoRelacionado.IdDocumento` -> CFDI pagado) y calcula, por flujo de efectivo:
//   - saldo insoluto (declarado vs calculado) y si la parcialidad liquida la factura;
//   - IVA efectivamente pagado: trasladado (el contribuyente EMITIÓ el CFDI y cobró) o acreditable (RECIBIÓ el CFDI y
//     pagó), en el mes de `FechaPago`, no en el de la factura (LIVA art. 1-B y 5, fracción III).
//
// Todo en CENTAVOS ENTEROS. Fuente del IVA, en orden: (1) `ImpuestosDR` del propio REP (autoridad fiscal); (2) prorrateo
// de la factura ligada (IVA x pagado / total). Si no hay ninguna de las dos, `sin_dato`: nunca se inventa una cifra.
//
// Liga a CFDI PPD: la factura ligada debe tener MetodoPago = PPD (columna persistida por D-22). Una factura PUE, o una
// ingerida antes de D-22 (MetodoPago desconocido), se señala en `hallazgos`; nunca se asume. Solo pesos mexicanos: un
// documento en otra moneda se reporta pero no se suma ni se convierte (no se inventa un tipo de cambio).
// ═══════════════════════════════════════════════════════════════════════════
import { cfdiCatalogs } from "@atiende/billing";
import type { RepDocumentoRelacionado, RepPago, RepParseResult } from "@atiende/billing";

export type FlujoRep = "trasladado" | "acreditable";
export type FuenteIvaRep = "rep" | "prorrateo_factura" | "sin_dato";

/** Lo mínimo que el análisis necesita de una factura ya persistida. `totalCentavos`/`ivaCentavos` ya en centavos. */
export interface FacturaLigable {
  readonly folioFiscal: string;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly totalCentavos: number;
  readonly ivaCentavos: number | null;
  /** c_MetodoPago persistido (PUE/PPD); null = desconocido (CFDI ingerido antes de D-22 o con la base sin migrar). */
  readonly metodoPago: string | null;
}

export class RepRfcAjenoError extends Error {
  constructor() {
    super("El RFC del contribuyente no es ni el emisor ni el receptor del complemento de pago: no se puede determinar el flujo.");
  }
}

export interface AnalisisDocumentoRep {
  readonly idDocumento: string;
  readonly pagoIndex: number;
  readonly fechaPago: string;
  /** Mes del flujo de efectivo (YYYY-MM de la fecha de pago). */
  readonly periodoFlujo: string;
  readonly numParcialidad: number;
  readonly monedaDR: string;
  /** La factura pagada existe en el despacho y es del mismo emisor/receptor que el REP. */
  readonly ligado: boolean;
  readonly impSaldoAntCentavos: number;
  readonly impPagadoCentavos: number;
  readonly saldoInsolutoDeclaradoCentavos: number;
  /** ImpSaldoAnt - ImpPagado. */
  readonly saldoInsolutoCalculadoCentavos: number;
  readonly saldoCoherente: boolean;
  readonly liquidaFactura: boolean;
  /** La factura ligada es de método de pago PPD; null = no se pudo verificar (sin liga o método desconocido). */
  readonly facturaEsPpd: boolean | null;
  readonly ivaCentavos: number | null;
  readonly fuenteIva: FuenteIvaRep;
  readonly ivaRetenidoCentavos: number;
  /** false = el documento no se suma a los totales (moneda distinta de MXN). */
  readonly incluidoEnTotales: boolean;
  readonly hallazgos: readonly string[];
}

export interface AnalisisRep {
  readonly folioFiscalRep: string;
  readonly flujo: FlujoRep;
  readonly documentos: readonly AnalisisDocumentoRep[];
  readonly totales: { readonly pagadoCentavos: number; readonly ivaCentavos: number; readonly ivaRetenidoCentavos: number };
  /** IVA efectivamente pagado por mes de pago (flujo de efectivo). */
  readonly porPeriodo: Readonly<Record<string, { readonly pagadoCentavos: number; readonly ivaCentavos: number }>>;
  readonly documentosSinLigar: number;
  readonly advertencias: readonly string[];
}

/** Redondeo half-up de a*b/c con enteros no negativos (BigInt: sin desbordes ni punto flotante). */
export function proporcionCentavos(a: number, b: number, c: number): number {
  if (c <= 0) throw new Error("proporcionCentavos: el divisor debe ser positivo.");
  const num = BigInt(a) * BigInt(b);
  const den = BigInt(c);
  return Number((2n * num + den) / (2n * den));
}

function ivaDelRep(d: RepDocumentoRelacionado): { centavos: number; encontrado: boolean } {
  const iva = d.traslados.filter((t) => t.impuesto === "002");
  if (d.objetoImpDR === "01") return { centavos: 0, encontrado: true };
  if (iva.length === 0) return { centavos: 0, encontrado: false };
  return { centavos: iva.reduce((s, t) => s + (t.importeCentavos ?? 0), 0), encontrado: true };
}

function ivaRetenidoDelRep(d: RepDocumentoRelacionado): number {
  return d.retenciones.filter((r) => r.impuesto === "002").reduce((s, r) => s + (r.importeCentavos ?? 0), 0);
}

/** c_TipoCadenaPago vigente: solo "01" (SPEI). Cualquier otro valor es un aviso, no un rechazo. */
const TIPOS_CADENA_PAGO = new Set(["01"]);

/**
 * D-P3-31: avisos (nunca errores) sobre los campos de pago de un REP: FormaDePagoP contra el catalogo c_FormaPago (y sin "99", que el
 * complemento de pago no admite), MonedaP con forma ISO 4217, TipoCambioP obligatorio con moneda extranjera y TipoCadPago valido.
 */
export function avisosPagoRep(pago: RepPago, indice: number): string[] {
  const avisos: string[] = [];
  const n = indice + 1;
  if (!cfdiCatalogs.esFormaPagoValida(pago.formaDePagoP)) avisos.push(`Pago ${n}: FormaDePagoP '${pago.formaDePagoP}' no esta en el catalogo c_FormaPago.`);
  else if (pago.formaDePagoP === "99") avisos.push(`Pago ${n}: FormaDePagoP 99 (Por definir) no es valida en un complemento de pago: debe ser la forma real en que se pago.`);
  if (!/^[A-Z]{3}$/.test(pago.monedaP)) avisos.push(`Pago ${n}: MonedaP '${pago.monedaP}' no tiene forma de codigo ISO 4217 (3 letras mayusculas).`);
  const extranjera = /^[A-Z]{3}$/.test(pago.monedaP) && pago.monedaP !== "MXN" && pago.monedaP !== "XXX";
  const tipoCambio = pago.tipoCambioP ?? null;
  if (extranjera) {
    if (tipoCambio === null) avisos.push(`Pago ${n}: TipoCambioP es obligatorio cuando MonedaP es ${pago.monedaP} (moneda distinta de MXN).`);
    else if (!(Number(tipoCambio) > 0)) avisos.push(`Pago ${n}: TipoCambioP '${tipoCambio}' no es un numero mayor que cero.`);
  } else if (pago.monedaP === "MXN" && tipoCambio !== null && Number(tipoCambio) !== 1) {
    avisos.push(`Pago ${n}: con MonedaP MXN el TipoCambioP debe ser 1 (viene '${tipoCambio}').`);
  }
  const cad = pago.tipoCadPago ?? null;
  if (cad !== null && !TIPOS_CADENA_PAGO.has(cad)) avisos.push(`Pago ${n}: TipoCadPago '${cad}' no esta en el catalogo c_TipoCadenaPago.`);
  return avisos;
}

export function analizarComplementoPago(rep: RepParseResult, rfcContribuyente: string, facturas: ReadonlyMap<string, FacturaLigable>): AnalisisRep {
  const rfc = rfcContribuyente.trim().toUpperCase();
  let flujo: FlujoRep;
  if (rfc === rep.rfcEmisor.toUpperCase()) flujo = "trasladado";
  else if (rfc === rep.rfcReceptor.toUpperCase()) flujo = "acreditable";
  else throw new RepRfcAjenoError();

  const documentos: AnalisisDocumentoRep[] = [];
  const advertencias: string[] = [];

  rep.pagos.forEach((pago, pagoIndex) => {
    advertencias.push(...avisosPagoRep(pago, pagoIndex));
    let sumaPagadoMxn = 0;
    let todosMxn = pago.monedaP === "MXN";
    for (const d of pago.documentos) {
      const hallazgos: string[] = [];
      const factura = facturas.get(d.idDocumento);
      const mxn = d.monedaDR === "MXN" && d.equivalenciaDR === "1";
      if (!mxn) {
        todosMxn = false;
        hallazgos.push(`Documento en moneda ${d.monedaDR} (equivalencia ${d.equivalenciaDR}): no se suma ni se convierte; revisar con el fiscalista.`);
      }

      let ligado = false;
      if (!factura) {
        hallazgos.push("El CFDI pagado no está en el despacho: súbelo para ligarlo.");
      } else if (factura.rfcEmisor.toUpperCase() !== rep.rfcEmisor.toUpperCase() || factura.rfcReceptor.toUpperCase() !== rep.rfcReceptor.toUpperCase()) {
        hallazgos.push("El CFDI ligado tiene emisor/receptor distintos a los del complemento de pago.");
      } else {
        ligado = true;
      }
      let facturaEsPpd: boolean | null = null;
      if (ligado && factura) {
        if (factura.metodoPago === null) {
          hallazgos.push("No se pudo verificar que la factura ligada sea PPD: su método de pago no está registrado (CFDI ingerido antes de D-22).");
        } else {
          facturaEsPpd = factura.metodoPago === "PPD";
          if (!facturaEsPpd) hallazgos.push(`La factura ligada es de método de pago ${factura.metodoPago}: un CFDI PUE no debería tener complemento de pago.`);
        }
      }

      const calculado = d.impSaldoAntCentavos - d.impPagadoCentavos;
      const saldoCoherente = calculado === d.impSaldoInsolutoCentavos;
      if (!saldoCoherente) hallazgos.push("ImpSaldoInsoluto no es ImpSaldoAnt menos ImpPagado.");
      if (d.impPagadoCentavos <= 0) hallazgos.push("ImpPagado debe ser mayor a cero.");
      if (d.impSaldoInsolutoCentavos < 0) hallazgos.push("ImpSaldoInsoluto negativo: el pago excede el saldo.");
      if (ligado && factura && mxn && d.numParcialidad === 1 && d.impSaldoAntCentavos !== factura.totalCentavos) {
        hallazgos.push("En la parcialidad 1 el saldo anterior debería ser el total de la factura ligada.");
      }

      // IVA: el REP manda; si no lo trae, prorrateo de la factura ligada.
      let ivaCentavos: number | null = null;
      let fuenteIva: FuenteIvaRep = "sin_dato";
      const delRep = ivaDelRep(d);
      const prorrateo =
        ligado && factura && factura.ivaCentavos !== null && factura.totalCentavos > 0 && d.impPagadoCentavos >= 0
          ? proporcionCentavos(factura.ivaCentavos, d.impPagadoCentavos, factura.totalCentavos)
          : null;
      if (delRep.encontrado) {
        ivaCentavos = delRep.centavos;
        fuenteIva = "rep";
        if (prorrateo !== null && Math.abs(prorrateo - delRep.centavos) > 1) {
          hallazgos.push("El IVA del complemento difiere del proporcional de la factura ligada: revisar.");
        }
      } else if (prorrateo !== null) {
        ivaCentavos = prorrateo;
        fuenteIva = "prorrateo_factura";
      } else {
        hallazgos.push("Sin IVA en el complemento ni factura ligada con IVA: no se calcula el IVA de este pago.");
      }

      if (mxn) sumaPagadoMxn += d.impPagadoCentavos;
      documentos.push({
        idDocumento: d.idDocumento,
        pagoIndex,
        fechaPago: pago.fechaPago,
        periodoFlujo: pago.fechaPago.slice(0, 7),
        numParcialidad: d.numParcialidad,
        monedaDR: d.monedaDR,
        ligado,
        impSaldoAntCentavos: d.impSaldoAntCentavos,
        impPagadoCentavos: d.impPagadoCentavos,
        saldoInsolutoDeclaradoCentavos: d.impSaldoInsolutoCentavos,
        saldoInsolutoCalculadoCentavos: calculado,
        saldoCoherente,
        liquidaFactura: d.impSaldoInsolutoCentavos === 0 && saldoCoherente,
        facturaEsPpd,
        ivaCentavos,
        fuenteIva,
        ivaRetenidoCentavos: ivaRetenidoDelRep(d),
        incluidoEnTotales: mxn,
        hallazgos,
      });
    }
    if (todosMxn && sumaPagadoMxn !== pago.montoCentavos) {
      advertencias.push(`Pago ${pagoIndex + 1}: Monto (${pago.montoCentavos} centavos) no coincide con la suma de ImpPagado (${sumaPagadoMxn} centavos).`);
    }
  });

  const incluidos = documentos.filter((d) => d.incluidoEnTotales);
  const porPeriodo: Record<string, { pagadoCentavos: number; ivaCentavos: number }> = {};
  for (const d of incluidos) {
    const acum = porPeriodo[d.periodoFlujo] ?? { pagadoCentavos: 0, ivaCentavos: 0 };
    porPeriodo[d.periodoFlujo] = { pagadoCentavos: acum.pagadoCentavos + d.impPagadoCentavos, ivaCentavos: acum.ivaCentavos + (d.ivaCentavos ?? 0) };
  }
  const sinIva = incluidos.filter((d) => d.ivaCentavos === null).length;
  if (sinIva > 0) advertencias.push(`${sinIva} documento(s) sin IVA calculable: el total de IVA es parcial.`);

  return {
    folioFiscalRep: rep.folioFiscal,
    flujo,
    documentos,
    totales: {
      pagadoCentavos: incluidos.reduce((s, d) => s + d.impPagadoCentavos, 0),
      ivaCentavos: incluidos.reduce((s, d) => s + (d.ivaCentavos ?? 0), 0),
      ivaRetenidoCentavos: incluidos.reduce((s, d) => s + d.ivaRetenidoCentavos, 0),
    },
    porPeriodo,
    documentosSinLigar: documentos.filter((d) => !d.ligado).length,
    advertencias,
  };
}
