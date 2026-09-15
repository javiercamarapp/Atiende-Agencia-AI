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
// QUEDAN FUERA (no se finge soporte): comercio exterior, pagos en
// parcialidades/complemento de pagos, nómina vía XML (ya existe
// `generarXmlCfdiNomina` para el sentido inverso, emisión, no consumo), y
// cualquier CFDI con más de un `cfdi:Comprobante` en el mismo archivo.
// ═══════════════════════════════════════════════════════════════════════════
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export class CfdiXmlParseError extends Error {}

export interface CfdiXmlConcepto {
  readonly cantidad: number;
  readonly valorUnitario: number;
  readonly importe: number;
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
  readonly cfdiRelacionados?: readonly string[];
  readonly tipoRelacion?: string;
}

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
  const relevantes = fuente.filter((n) => attrString(n.Impuesto) === codigoImpuesto);
  if (relevantes.length === 0) return null;
  return relevantes.reduce((acc, n) => acc + requireAttrNumber(n.Importe, `${nodo}.Importe`), 0);
}

export function parseCfdiXml(xml: string): CfdiXmlParseResult {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    throw new CfdiXmlParseError('El XML está vacío.');
  }

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
  }));

  const timbre = (comprobante.Complemento as Record<string, unknown> | undefined)?.TimbreFiscalDigital as Record<string, unknown> | undefined;
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
    cfdiRelacionados,
    tipoRelacion,
  };
}
