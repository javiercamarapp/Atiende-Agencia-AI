// ═══════════════════════════════════════════════════════════════════════════
// PARSER DE CFDI 4.0 (XML DEL SAT) — cierra el gap de auditoría "no existe ningún
// parser de XML CFDI en el monorepo": hoy `POST /despachos/:propertyId/cfdi`
// exige el JSON ya desarmado a mano (15+ campos); en la vida real un despacho
// recibe el CFDI como archivo XML timbrado por el PAC, nunca como ese JSON.
//
// Este módulo SOLO extrae y tipa los datos del XML — no valida coherencia fiscal
// (eso lo sigue haciendo exclusivamente `validarCfdi()`/`validarCfdiDespachos()`,
// nunca se duplica esa lógica aquí) y no calcula nada: es un traductor XML -> el
// mismo shape que `DatosCfdiDespachos` ya exige.
//
// ALCANCE (documentado explícitamente, ver TAREA): cubre el camino feliz de un
// CFDI 4.0 con un solo nodo `cfdi:Comprobante`, N conceptos, impuestos
// trasladados/retenidos "planos" (un renglón de IVA/IEPS/ISR por concepto o a
// nivel comprobante) y el complemento `tfd:TimbreFiscalDigital` para el UUID.
// QUEDAN FUERA (no se finge soporte): comercio exterior, el complemento de
// pagos (ver `rep-parser.ts`, D-23: se procesa aparte, no como factura), nómina vía XML (ya existe
// `generarXmlCfdiNomina` para el sentido inverso, emisión, no consumo), y
// cualquier CFDI con más de un `cfdi:Comprobante` en el mismo archivo.
//
// SEGURIDAD DE LA ENTRADA (D-22/D-29): el XML llega de un tercero (PAC, cliente del
// despacho, portal). Antes de parsear se rechaza todo lo que no es un CFDI plano:
// DTD/entidades (`<!DOCTYPE`, `<!ENTITY`: cierra XXE y la expansión de entidades),
// hojas de estilo, bytes NUL, codificación declarada distinta de UTF-8 y documentos
// de más de `CFDI_XML_MAX_CARACTERES`. El parser nunca resuelve nada externo ni
// ejecuta nada; solo lee atributos.
// ═══════════════════════════════════════════════════════════════════════════
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { TrasladoConceptoCfdi } from './validator.ts';

export class CfdiXmlParseError extends Error {}

/** Un renglón de impuesto desglosado (Anexo 20: Traslado / Retencion). Los montos son
 * cadenas decimales EXACTAS (suma sin pasar por flotantes, 6 decimales) para que el
 * llamador las convierta a centavos sin error de punto flotante. */
export interface CfdiXmlImpuesto {
  readonly naturaleza: 'traslado' | 'retencion';
  /** c_Impuesto: 001 ISR, 002 IVA, 003 IEPS. */
  readonly impuesto: string;
  readonly tipoFactor: 'Tasa' | 'Cuota' | 'Exento';
  /** Tasa o cuota normalizada a 6 decimales ("0.160000"); null si es Exento. */
  readonly tasaOCuota: string | null;
  readonly base: string | null;
  readonly importe: string | null;
}

export interface CfdiXmlConcepto {
  readonly cantidad: number;
  readonly valorUnitario: number;
  readonly importe: number;
  /** D-P3-31: traslados del concepto (IVA/IEPS) tal como vienen en el XML; vacío si el concepto no trae desglose. */
  readonly traslados: readonly TrasladoConceptoCfdi[];
}

/** Mismo shape que `DatosCfdiDespachos` (@atiende/domain-despachos) menos los
 * campos que ese XML nunca trae (nomina, tasaIva/moneda/tipoCambio explícitos —
 * se derivan donde ya se derivaban antes de este parser) y menos `categoria`
 * (clasificación contable interna, no un dato del CFDI). */
export interface CfdiXmlParseResult {
  readonly folioFiscal: string;
  readonly tipo: string;
  readonly subtotal: number;
  readonly total: number;
  readonly descuento: number;
  readonly iva: number | null;
  /** Mutable (no `readonly`) a propósito: `DatosCfdi.conceptos`
   * (@atiende/billing/cfdi/validator.ts) también lo es — este shape debe
   * asignarse sin fricción donde ya se espera `DatosCfdi`/`DatosCfdiDespachos`. */
  readonly conceptos: CfdiXmlConcepto[];
  readonly usoCfdi: string;
  readonly formaPago: string;
  readonly metodoPago: string;
  readonly regimenFiscalEmisor: string;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly emisorNombre: string;
  readonly tieneSello: boolean;
  readonly noCertificado: string;
  readonly fecha: string;
  readonly fechaTimbrado: string | null;
  readonly retencionIsr: number | null;
  readonly retencionIva: number | null;
  readonly ieps: number | null;
  /** D-P3-01: `implocal:ImpuestosLocales` TotaldeTraslados (ISH, etc.); null si el complemento no viene. Se SUMA al total. */
  readonly impuestosLocalesTraslados: number | null;
  /** D-P3-01: `implocal:ImpuestosLocales` TotaldeRetenciones; null si el complemento no viene. Se RESTA del total. */
  readonly impuestosLocalesRetenciones: number | null;
  /** D-P3-31: RegimenFiscalReceptor (obligatorio en CFDI 4.0; puede faltar en un XML mal armado, por eso no se exige aquí). */
  readonly regimenFiscalReceptor?: string;
  readonly cfdiRelacionados?: readonly string[];
  readonly tipoRelacion?: string;
  /** Moneda del comprobante (atributo obligatorio en CFDI 4.0; "MXN", "USD", "XXX"...). */
  readonly moneda: string;
  /** TipoCambio del comprobante; undefined cuando el XML no lo trae (MXN/XXX). */
  readonly tipoCambio?: number;
  /** Desglose de impuestos por (naturaleza, impuesto, factor, tasa). Vacío si el XML no trae detalle utilizable. */
  readonly impuestos: readonly CfdiXmlImpuesto[];
}

export const CFDI_XML_MAX_CARACTERES = 2 * 1024 * 1024;

// Catálogo c_Impuesto del SAT (los tres relevantes para el camino feliz —
// ver catalogs.ts para el resto de catálogos SAT ya portados).
const IMPUESTO_ISR = '001';
const IMPUESTO_IVA = '002';
const IMPUESTO_IEPS = '003';

const REPEATABLE_TAGS = new Set(['Concepto', 'Traslado', 'Retencion', 'CfdiRelacionado']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => REPEATABLE_TAGS.has(name),
});

function asArray<T>(value: T | readonly T[] | undefined | null): readonly T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as readonly T[];
  return [value as T];
}

function attrString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function requireAttrString(value: unknown, campo: string): string {
  const s = attrString(value);
  if (!s) throw new CfdiXmlParseError(`El XML no trae ${campo} (atributo obligatorio del CFDI).`);
  return s;
}

function requireAttrNumber(value: unknown, campo: string): number {
  const s = requireAttrString(value, campo);
  const n = Number(s);
  if (!Number.isFinite(n)) throw new CfdiXmlParseError(`${campo}='${s}' no es un número válido.`);
  return n;
}

function optionalAttrNumber(value: unknown, campo: string): number | null {
  const s = attrString(value);
  if (s === undefined) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new CfdiXmlParseError(`${campo}='${s}' no es un número válido.`);
  return n;
}

/** Suma los importes de todos los nodos Traslado/Retencion (a nivel comprobante
 * O anidados por concepto — un CFDI real puede traer el desglose en cualquiera
 * de los dos niveles, o en ambos con el nivel comprobante como total) que
 * correspondan a `codigoImpuesto`. Devuelve `null` cuando no hay NINGÚN nodo de
 * ese tipo (distinto de 0, que sí sería una tasa de 0% real). */
function sumarImporteImpuesto(
  comprobante: Record<string, unknown>,
  bloque: 'Traslados' | 'Retenciones',
  nodo: 'Traslado' | 'Retencion',
  codigoImpuesto: string,
): number | null {
  const nivelComprobante = asArray(
    ((comprobante.Impuestos as Record<string, unknown> | undefined)?.[bloque] as Record<string, unknown> | undefined)?.[nodo] as
      | Record<string, unknown>
      | readonly Record<string, unknown>[]
      | undefined,
  );

  const conceptos = asArray(
    (comprobante.Conceptos as Record<string, unknown> | undefined)?.Concepto as Record<string, unknown> | readonly Record<string, unknown>[] | undefined,
  );
  const nivelConcepto = conceptos.flatMap((c) =>
    asArray(((c.Impuestos as Record<string, unknown> | undefined)?.[bloque] as Record<string, unknown> | undefined)?.[nodo] as
      | Record<string, unknown>
      | readonly Record<string, unknown>[]
      | undefined),
  );

  // El nivel comprobante ya es la suma agregada de todos los conceptos (Anexo 20):
  // si está presente, es la fuente de verdad y evita sumar doble.
  const fuente = nivelComprobante.length > 0 ? nivelComprobante : nivelConcepto;
  // Un traslado con TipoFactor="Exento" no trae Importe (Anexo 20): no suma nada y NO debe tumbar la
  // lectura de todo el comprobante (antes lanzaba "no trae Traslado.Importe" ante un CFDI con IVA exento).
  const relevantes = fuente.filter((n) => attrString(n.Impuesto) === codigoImpuesto && attrString(n.TipoFactor) !== 'Exento');
  if (relevantes.length === 0) return null;
  return relevantes.reduce((acc, n) => acc + requireAttrNumber(n.Importe, `${nodo}.Importe`), 0);
}

/** "16.000001" -> 16000001n (micros). Acepta hasta 6 decimales (máximo del Anexo 20); null si no es decimal. */
function decimalAMicros(valor: string): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(valor.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1000000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

function microsADecimal(micros: bigint): string {
  const entero = micros / 1000000n;
  const frac = (micros % 1000000n).toString().padStart(6, '0');
  return `${entero}.${frac}`;
}

function normalizarTasa(valor: string): string | null {
  const micros = decimalAMicros(valor);
  return micros === null ? null : microsADecimal(micros);
}

function extraerNodosImpuesto(
  contenedor: Record<string, unknown> | undefined,
  bloque: 'Traslados' | 'Retenciones',
  nodo: 'Traslado' | 'Retencion',
): readonly Record<string, unknown>[] {
  return asArray(
    ((contenedor?.Impuestos as Record<string, unknown> | undefined)?.[bloque] as Record<string, unknown> | undefined)?.[nodo] as
      | Record<string, unknown>
      | readonly Record<string, unknown>[]
      | undefined,
  );
}

/** Desglose de impuestos. Fuente preferida: los nodos por concepto (traen Base, TipoFactor y
 * TasaOCuota también para retenciones, que a nivel comprobante vienen sin tasa); si ningún concepto
 * trae desglose, los traslados del nivel comprobante. Las retenciones solo a nivel comprobante (sin
 * tasa ni factor) NO se desglosan: su total ya viaja en `retencionIsr`/`retencionIva`. */
function desglosarImpuestos(comprobante: Record<string, unknown>): readonly CfdiXmlImpuesto[] {
  const conceptos = asArray(
    (comprobante.Conceptos as Record<string, unknown> | undefined)?.Concepto as Record<string, unknown> | readonly Record<string, unknown>[] | undefined,
  );
  const candidatos: { naturaleza: 'traslado' | 'retencion'; nodo: Record<string, unknown> }[] = [];
  for (const c of conceptos) {
    for (const n of extraerNodosImpuesto(c, 'Traslados', 'Traslado')) candidatos.push({ naturaleza: 'traslado', nodo: n });
    for (const n of extraerNodosImpuesto(c, 'Retenciones', 'Retencion')) candidatos.push({ naturaleza: 'retencion', nodo: n });
  }
  if (candidatos.length === 0) {
    for (const n of extraerNodosImpuesto(comprobante, 'Traslados', 'Traslado')) candidatos.push({ naturaleza: 'traslado', nodo: n });
  }

  const grupos = new Map<string, { naturaleza: 'traslado' | 'retencion'; impuesto: string; tipoFactor: 'Tasa' | 'Cuota' | 'Exento'; tasa: string | null; base: bigint; importe: bigint; tieneBase: boolean; tieneImporte: boolean }>();
  for (const { naturaleza, nodo } of candidatos) {
    const impuesto = attrString(nodo.Impuesto);
    const factor = attrString(nodo.TipoFactor);
    if (!impuesto || !/^00[123]$/.test(impuesto)) continue;
    if (factor !== 'Tasa' && factor !== 'Cuota' && factor !== 'Exento') continue;
    if (factor === 'Exento' && naturaleza === 'retencion') continue;
    const tasaTexto = attrString(nodo.TasaOCuota);
    const tasa = factor === 'Exento' ? null : tasaTexto ? normalizarTasa(tasaTexto) : null;
    if (factor !== 'Exento' && tasa === null) continue;
    const baseTexto = attrString(nodo.Base);
    const importeTexto = attrString(nodo.Importe);
    const base = baseTexto ? decimalAMicros(baseTexto) : null;
    const importe = importeTexto ? decimalAMicros(importeTexto) : null;
    if (factor !== 'Exento' && importe === null) continue;
    const clave = `${naturaleza}|${impuesto}|${factor}|${tasa ?? ''}`;
    const g = grupos.get(clave) ?? { naturaleza, impuesto, tipoFactor: factor, tasa, base: 0n, importe: 0n, tieneBase: false, tieneImporte: false };
    if (base !== null) {
      g.base += base;
      g.tieneBase = true;
    }
    if (importe !== null) {
      g.importe += importe;
      g.tieneImporte = true;
    }
    grupos.set(clave, g);
  }
  return [...grupos.values()].map((g) => ({
    naturaleza: g.naturaleza,
    impuesto: g.impuesto,
    tipoFactor: g.tipoFactor,
    tasaOCuota: g.tasa,
    base: g.tieneBase ? microsADecimal(g.base) : null,
    importe: g.tieneImporte ? microsADecimal(g.importe) : null,
  }));
}

/** Traslados (IVA/IEPS) de un concepto con sus números; lo que no es numérico queda null y el validador lo ignora. */
function trasladosDeConcepto(concepto: Record<string, unknown>): TrasladoConceptoCfdi[] {
  const numOrNull = (v: unknown): number | null => {
    const s = attrString(v);
    if (s === undefined) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  return extraerNodosImpuesto(concepto, 'Traslados', 'Traslado').flatMap((n) => {
    const impuesto = attrString(n.Impuesto);
    const tipoFactor = attrString(n.TipoFactor);
    if (!impuesto || !tipoFactor) return [];
    return [{ impuesto, tipoFactor, tasaOCuota: numOrNull(n.TasaOCuota), base: numOrNull(n.Base), importe: numOrNull(n.Importe) }];
  });
}

/** Rechaza todo lo que no sea un CFDI plano ANTES de entregarlo al parser (ver cabecera: seguridad de la entrada). */
export function validarXmlCfdiSeguro(xml: string): void {
  if (xml.length > CFDI_XML_MAX_CARACTERES) {
    throw new CfdiXmlParseError('El XML excede el tamaño máximo permitido.');
  }
  // U+FFFD es lo que deja `Request.text()` al encontrar bytes que no son UTF-8 válido (D-29).
  if (xml.includes('\uFFFD')) throw new CfdiXmlParseError('El XML debe estar codificado en UTF-8 válido.');
  if (xml.includes('\u0000')) throw new CfdiXmlParseError('El XML contiene caracteres no permitidos.');
  // `<!` solo se admite para comentarios y CDATA: cualquier otra declaración (DOCTYPE, ENTITY, ELEMENT, ATTLIST...) se rechaza.
  if (/<!(?!--|\[CDATA\[)/.test(xml)) throw new CfdiXmlParseError('El XML no puede declarar DTD ni entidades.');
  if (/<\?xml-stylesheet/i.test(xml)) throw new CfdiXmlParseError('El XML no puede incluir hojas de estilo.');
  const codificacion = /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/i.exec(xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml);
  if (codificacion && codificacion[1]!.toLowerCase() !== 'utf-8') {
    throw new CfdiXmlParseError('El XML debe declarar codificación UTF-8.');
  }
}

/** Variante para bytes crudos (archivo subido): UTF-8 estricto (sin sustitución silenciosa por U+FFFD) y el mismo tope. */
export function parseCfdiXmlBytes(bytes: Uint8Array): CfdiXmlParseResult {
  if (bytes.byteLength > CFDI_XML_MAX_CARACTERES) throw new CfdiXmlParseError('El XML excede el tamaño máximo permitido.');
  let texto: string;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CfdiXmlParseError('El XML debe estar codificado en UTF-8 válido.');
  }
  return parseCfdiXml(texto);
}

export function parseCfdiXml(xml: string): CfdiXmlParseResult {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    throw new CfdiXmlParseError('El XML está vacío.');
  }
  validarXmlCfdiSeguro(xml);

  const validacion = XMLValidator.validate(xml);
  if (validacion !== true) {
    throw new CfdiXmlParseError(`XML mal formado: ${validacion.err.msg} (línea ${validacion.err.line}).`);
  }

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new CfdiXmlParseError(`No se pudo parsear el XML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const comprobante = doc.Comprobante as Record<string, unknown> | undefined;
  if (!comprobante || typeof comprobante !== 'object') {
    throw new CfdiXmlParseError('No es un CFDI válido: falta el nodo raíz cfdi:Comprobante.');
  }

  if (attrString(comprobante.TipoDeComprobante) === 'P') {
    throw new CfdiXmlParseError('Es un CFDI de pago (tipo P): se procesa con el complemento de pago 2.0, no como factura.');
  }

  const version = attrString(comprobante.Version);
  if (version !== '4.0') {
    throw new CfdiXmlParseError(`Solo se soporta CFDI versión 4.0 (el XML trae Version='${version ?? '(ausente)'}').`);
  }

  const emisor = comprobante.Emisor as Record<string, unknown> | undefined;
  if (!emisor) throw new CfdiXmlParseError('El XML no trae cfdi:Emisor.');
  const receptor = comprobante.Receptor as Record<string, unknown> | undefined;
  if (!receptor) throw new CfdiXmlParseError('El XML no trae cfdi:Receptor.');

  const conceptosRaw = asArray(
    (comprobante.Conceptos as Record<string, unknown> | undefined)?.Concepto as Record<string, unknown> | readonly Record<string, unknown>[] | undefined,
  );
  if (conceptosRaw.length === 0) throw new CfdiXmlParseError('El XML no trae ningún cfdi:Concepto.');
  const conceptos: CfdiXmlConcepto[] = conceptosRaw.map((c, i) => ({
    cantidad: requireAttrNumber(c.Cantidad, `Conceptos[${i}].Cantidad`),
    valorUnitario: requireAttrNumber(c.ValorUnitario, `Conceptos[${i}].ValorUnitario`),
    importe: requireAttrNumber(c.Importe, `Conceptos[${i}].Importe`),
    traslados: trasladosDeConcepto(c),
  }));

  const complemento = comprobante.Complemento as Record<string, unknown> | undefined;
  // `implocal:ImpuestosLocales` (el prefijo se quita al parsear): TotaldeTraslados se suma y TotaldeRetenciones se resta del Total.
  const locales = complemento?.ImpuestosLocales as Record<string, unknown> | undefined;
  const timbre = complemento?.TimbreFiscalDigital as Record<string, unknown> | undefined;
  if (!timbre) {
    throw new CfdiXmlParseError('El XML no trae tfd:TimbreFiscalDigital — sin timbrado no hay folio fiscal (UUID) ni efecto fiscal.');
  }
  const folioFiscal = requireAttrString(timbre.UUID, 'TimbreFiscalDigital.UUID');
  const fechaTimbrado = attrString(timbre.FechaTimbrado) ?? null;

  const cfdiRelacionadosNodo = comprobante.CfdiRelacionados as Record<string, unknown> | undefined;
  const cfdiRelacionados = cfdiRelacionadosNodo
    ? asArray(cfdiRelacionadosNodo.CfdiRelacionado as Record<string, unknown> | readonly Record<string, unknown>[] | undefined)
        .map((r) => attrString(r.UUID))
        .filter((u): u is string => Boolean(u))
    : undefined;
  const tipoRelacion = cfdiRelacionadosNodo ? attrString(cfdiRelacionadosNodo.TipoRelacion) : undefined;

  return {
    folioFiscal,
    tipo: requireAttrString(comprobante.TipoDeComprobante, 'TipoDeComprobante'),
    subtotal: requireAttrNumber(comprobante.SubTotal, 'SubTotal'),
    total: requireAttrNumber(comprobante.Total, 'Total'),
    descuento: optionalAttrNumber(comprobante.Descuento, 'Descuento') ?? 0,
    iva: sumarImporteImpuesto(comprobante, 'Traslados', 'Traslado', IMPUESTO_IVA),
    conceptos,
    usoCfdi: requireAttrString(receptor.UsoCFDI, 'Receptor.UsoCFDI'),
    formaPago: requireAttrString(comprobante.FormaPago, 'FormaPago'),
    metodoPago: requireAttrString(comprobante.MetodoPago, 'MetodoPago'),
    regimenFiscalEmisor: requireAttrString(emisor.RegimenFiscal, 'Emisor.RegimenFiscal'),
    rfcEmisor: requireAttrString(emisor.Rfc, 'Emisor.Rfc'),
    rfcReceptor: requireAttrString(receptor.Rfc, 'Receptor.Rfc'),
    emisorNombre: requireAttrString(emisor.Nombre, 'Emisor.Nombre'),
    tieneSello: Boolean(attrString(comprobante.Sello)),
    noCertificado: requireAttrString(comprobante.NoCertificado, 'NoCertificado'),
    fecha: requireAttrString(comprobante.Fecha, 'Fecha'),
    fechaTimbrado,
    retencionIsr: sumarImporteImpuesto(comprobante, 'Retenciones', 'Retencion', IMPUESTO_ISR),
    retencionIva: sumarImporteImpuesto(comprobante, 'Retenciones', 'Retencion', IMPUESTO_IVA),
    ieps: sumarImporteImpuesto(comprobante, 'Traslados', 'Traslado', IMPUESTO_IEPS),
    impuestosLocalesTraslados: locales ? optionalAttrNumber(locales.TotaldeTraslados, 'ImpuestosLocales.TotaldeTraslados') : null,
    impuestosLocalesRetenciones: locales ? optionalAttrNumber(locales.TotaldeRetenciones, 'ImpuestosLocales.TotaldeRetenciones') : null,
    regimenFiscalReceptor: attrString(receptor.RegimenFiscalReceptor),
    cfdiRelacionados,
    tipoRelacion,
    moneda: requireAttrString(comprobante.Moneda, 'Moneda'),
    tipoCambio: optionalAttrNumber(comprobante.TipoCambio, 'TipoCambio') ?? undefined,
    impuestos: desglosarImpuestos(comprobante),
  };
}
