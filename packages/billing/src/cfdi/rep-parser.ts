// ═══════════════════════════════════════════════════════════════════════════
// PARSER DEL COMPLEMENTO DE PAGO 2.0 (REP, CFDI 4.0 tipo "P") — D-23.
// Solo EXTRAE y tipa: no consulta al SAT ni a un PAC, no valida contra la factura original (eso lo hace
// `analizarComplementoPago` en @atiende/domain-despachos con las facturas ya persistidas).
//
// - Montos en CENTAVOS ENTEROS: se leen del texto decimal sin pasar por `Number` (sin errores de punto flotante).
//   El Anexo 20 admite hasta 6 decimales en importes de impuestos; se redondea half-up a centavos.
// - Misma defensa que `parseCfdiXml` (D-29): sin DTD/entidades/hojas de estilo, UTF-8, tope de tamano.
// - Solo Pagos 2.0 (vigente desde 2023). El 1.0 se rechaza explícito: no se adivina su estructura.
// - Alcance: IVA (002) trasladado/retenido por documento relacionado (ImpuestosDR). IEPS/ISR en el desglose se
//   conservan tal cual (codigo de impuesto), sin interpretarlos.
// ═══════════════════════════════════════════════════════════════════════════
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { CfdiXmlParseError, validarXmlCfdiSeguro } from './xml-parser.ts';

export interface RepImpuestoDocumento {
  readonly impuesto: string; // c_Impuesto: 001 ISR, 002 IVA, 003 IEPS
  readonly tipoFactor: string | null;
  readonly tasaOCuota: string | null;
  readonly baseCentavos: number;
  /** null cuando el factor es Exento (no trae importe). */
  readonly importeCentavos: number | null;
}

export interface RepDocumentoRelacionado {
  /** UUID del CFDI pagado (el que se liga a la factura PPD). */
  readonly idDocumento: string;
  readonly serie: string | null;
  readonly folio: string | null;
  readonly monedaDR: string;
  /** Texto tal cual: equivalencia de la moneda del documento a la del pago ("1" en MXN). */
  readonly equivalenciaDR: string;
  readonly numParcialidad: number;
  readonly impSaldoAntCentavos: number;
  readonly impPagadoCentavos: number;
  readonly impSaldoInsolutoCentavos: number;
  /** c_ObjetoImp: 01 no objeto, 02 si objeto, 03 si objeto y no obligado al desglose, 04 si objeto y no causa. */
  readonly objetoImpDR: string;
  readonly traslados: readonly RepImpuestoDocumento[];
  readonly retenciones: readonly RepImpuestoDocumento[];
}

export interface RepPago {
  readonly fechaPago: string;
  readonly formaDePagoP: string;
  readonly monedaP: string;
  /** D-P3-31: TipoCambioP tal cual (texto); null si no viene. Obligatorio cuando MonedaP no es MXN. Opcional en el tipo para no romper literales existentes. */
  readonly tipoCambioP?: string | null;
  /** D-P3-31: TipoCadPago (c_TipoCadenaPago, p. ej. "01" SPEI); null si no viene. */
  readonly tipoCadPago?: string | null;
  readonly montoCentavos: number;
  readonly documentos: readonly RepDocumentoRelacionado[];
}

export interface RepParseResult {
  readonly folioFiscal: string;
  readonly fecha: string;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly emisorNombre: string | null;
  readonly pagos: readonly RepPago[];
}

const REPEATABLE = new Set(['Pago', 'DoctoRelacionado', 'TrasladoDR', 'RetencionDR', 'TrasladoP', 'RetencionP']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => REPEATABLE.has(name),
});

type Nodo = Record<string, unknown>;

function asArray<T>(value: T | readonly T[] | undefined | null): readonly T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

function texto(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function requerido(value: unknown, campo: string): string {
  const s = texto(value);
  if (!s) throw new CfdiXmlParseError(`El XML no trae ${campo} (atributo obligatorio del complemento de pago).`);
  return s;
}

/** "1160.50" -> 116050. Sin `Number`: parte entera y decimal por separado; mas de 2 decimales se redondean half-up. */
export function decimalACentavos(valor: string, campo: string): number {
  const m = /^(-?)(\d{1,13})(?:\.(\d{1,10}))?$/.exec(valor);
  if (!m) throw new CfdiXmlParseError(`${campo}='${valor}' no es un importe decimal válido.`);
  const signo = m[1] === '-' ? -1 : 1;
  const decimales = (m[3] ?? '').padEnd(3, '0');
  let centavos = Number(m[2]) * 100 + Number(decimales.slice(0, 2));
  if (Number(decimales[2]) >= 5) centavos += 1;
  return signo * centavos;
}

function importe(value: unknown, campo: string): number {
  return decimalACentavos(requerido(value, campo), campo);
}

function impuestos(nodos: readonly Nodo[], campo: string, conImporte: boolean): RepImpuestoDocumento[] {
  return nodos.map((n, i) => {
    const imp = texto(n.ImporteDR);
    if (conImporte && imp === undefined && texto(n.TipoFactorDR) !== 'Exento') {
      throw new CfdiXmlParseError(`El XML no trae ${campo}[${i}].ImporteDR.`);
    }
    return {
      impuesto: requerido(n.ImpuestoDR, `${campo}[${i}].ImpuestoDR`),
      tipoFactor: texto(n.TipoFactorDR) ?? null,
      tasaOCuota: texto(n.TasaOCuotaDR) ?? null,
      baseCentavos: importe(n.BaseDR, `${campo}[${i}].BaseDR`),
      importeCentavos: imp === undefined ? null : decimalACentavos(imp, `${campo}[${i}].ImporteDR`),
    };
  });
}

export function parseComplementoPagoXml(xml: string): RepParseResult {
  if (typeof xml !== 'string' || xml.trim().length === 0) throw new CfdiXmlParseError('El XML está vacío.');
  validarXmlCfdiSeguro(xml);
  const validacion = XMLValidator.validate(xml);
  if (validacion !== true) throw new CfdiXmlParseError(`XML mal formado: ${validacion.err.msg} (línea ${validacion.err.line}).`);

  let doc: Nodo;
  try {
    doc = parser.parse(xml) as Nodo;
  } catch (err) {
    throw new CfdiXmlParseError(`No se pudo parsear el XML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const comprobante = doc.Comprobante as Nodo | undefined;
  if (!comprobante || typeof comprobante !== 'object') throw new CfdiXmlParseError('No es un CFDI válido: falta el nodo raíz cfdi:Comprobante.');
  if (texto(comprobante.Version) !== '4.0') throw new CfdiXmlParseError(`Solo se soporta CFDI versión 4.0 (el XML trae Version='${texto(comprobante.Version) ?? '(ausente)'}').`);
  if (texto(comprobante.TipoDeComprobante) !== 'P') throw new CfdiXmlParseError("El CFDI no es un complemento de pago: TipoDeComprobante debe ser 'P'.");

  const emisor = comprobante.Emisor as Nodo | undefined;
  const receptor = comprobante.Receptor as Nodo | undefined;
  if (!emisor) throw new CfdiXmlParseError('El XML no trae cfdi:Emisor.');
  if (!receptor) throw new CfdiXmlParseError('El XML no trae cfdi:Receptor.');

  const complemento = comprobante.Complemento as Nodo | undefined;
  const timbre = complemento?.TimbreFiscalDigital as Nodo | undefined;
  if (!timbre) throw new CfdiXmlParseError('El XML no trae tfd:TimbreFiscalDigital — sin timbrado no hay folio fiscal (UUID) ni efecto fiscal.');
  const pagosNodo = complemento?.Pagos as Nodo | undefined;
  if (!pagosNodo) throw new CfdiXmlParseError('El XML no trae el complemento pago20:Pagos.');
  const versionPagos = texto(pagosNodo.Version);
  if (versionPagos !== '2.0') {
    throw new CfdiXmlParseError(`Solo se soporta el complemento de pagos 2.0 (el XML trae Version='${versionPagos ?? '(ausente)'}'; la 1.0 está obsoleta).`);
  }

  const pagos: RepPago[] = asArray(pagosNodo.Pago as Nodo | readonly Nodo[] | undefined).map((p, i) => {
    const documentos = asArray(p.DoctoRelacionado as Nodo | readonly Nodo[] | undefined).map((d, j): RepDocumentoRelacionado => {
      const base = `Pago[${i}].DoctoRelacionado[${j}]`;
      const numParcialidad = Number(requerido(d.NumParcialidad, `${base}.NumParcialidad`));
      if (!Number.isInteger(numParcialidad) || numParcialidad < 1) throw new CfdiXmlParseError(`${base}.NumParcialidad no es un entero positivo.`);
      const dr = d.ImpuestosDR as Nodo | undefined;
      const traslados = asArray(((dr?.TrasladosDR as Nodo | undefined)?.TrasladoDR) as Nodo | readonly Nodo[] | undefined);
      const retenciones = asArray(((dr?.RetencionesDR as Nodo | undefined)?.RetencionDR) as Nodo | readonly Nodo[] | undefined);
      return {
        idDocumento: requerido(d.IdDocumento, `${base}.IdDocumento`).toLowerCase(),
        serie: texto(d.Serie) ?? null,
        folio: texto(d.Folio) ?? null,
        monedaDR: requerido(d.MonedaDR, `${base}.MonedaDR`),
        equivalenciaDR: texto(d.EquivalenciaDR) ?? '1',
        numParcialidad,
        impSaldoAntCentavos: importe(d.ImpSaldoAnt, `${base}.ImpSaldoAnt`),
        impPagadoCentavos: importe(d.ImpPagado, `${base}.ImpPagado`),
        impSaldoInsolutoCentavos: importe(d.ImpSaldoInsoluto, `${base}.ImpSaldoInsoluto`),
        objetoImpDR: requerido(d.ObjetoImpDR, `${base}.ObjetoImpDR`),
        traslados: impuestos(traslados, `${base}.TrasladoDR`, true),
        retenciones: impuestos(retenciones, `${base}.RetencionDR`, true),
      };
    });
    if (documentos.length === 0) throw new CfdiXmlParseError(`Pago[${i}] no trae ningún DoctoRelacionado.`);
    return {
      fechaPago: requerido(p.FechaPago, `Pago[${i}].FechaPago`),
      formaDePagoP: requerido(p.FormaDePagoP, `Pago[${i}].FormaDePagoP`),
      monedaP: requerido(p.MonedaP, `Pago[${i}].MonedaP`),
      tipoCambioP: texto(p.TipoCambioP) ?? null,
      tipoCadPago: texto(p.TipoCadPago) ?? null,
      montoCentavos: importe(p.Monto, `Pago[${i}].Monto`),
      documentos,
    };
  });
  if (pagos.length === 0) throw new CfdiXmlParseError('El complemento de pago no trae ningún nodo Pago.');

  return {
    folioFiscal: requerido(timbre.UUID, 'TimbreFiscalDigital.UUID').toLowerCase(),
    fecha: requerido(comprobante.Fecha, 'Fecha'),
    rfcEmisor: requerido(emisor.Rfc, 'Emisor.Rfc'),
    rfcReceptor: requerido(receptor.Rfc, 'Receptor.Rfc'),
    emisorNombre: texto(emisor.Nombre) ?? null,
    pagos,
  };
}
