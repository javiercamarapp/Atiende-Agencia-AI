// D-P3-44 -- lectura del XML de catálogo de cuentas y de balanza de comprobación (contabilidad electrónica 1.x) que entrega el proveedor anterior,
// para migrar a este libro. Puro: no toca la base ni la red. DEFENSA DE LA ENTRADA (misma que el parser de CFDI de @atiende/billing): tope de
// tamaño, UTF-8 válido, SIN DTD ni entidades (cierra XXE y la expansión de entidades) y sin hojas de estilo; el parser nunca resuelve nada externo.
//
// Lo que NO se acepta se reporta con su motivo (nunca se "arregla" en silencio): cuentas con NumCta que no es numérico de 4 a 10 dígitos (el libro
// solo maneja cuentas numéricas), hijas de una cuenta rechazada, niveles incoherentes y códigos agrupadores fuera de la lista del Anexo 24 (la cuenta
// se importa SIN código y el staff lo asigna).
import { CFDI_XML_MAX_CARACTERES, validarXmlCfdiSeguro } from "@atiende/billing";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { esCodigoAgrupadorSat } from "./codigos-agrupadores.ts";
import { RFC_SAT_RE } from "./xml-comun.ts";

export class ImportacionXmlContabilidadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportacionXmlContabilidadError";
  }
}

export const MAX_CUENTAS_IMPORTADAS = 5000;
export const MAX_PARTIDAS_APERTURA = 200;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
  isArray: (name) => name === "Ctas",
});

interface Crudo {
  readonly raiz: Record<string, unknown>;
  readonly nombreRaiz: string;
}

function leerSeguro(xml: unknown): Crudo {
  if (typeof xml !== "string" || xml.trim().length === 0) throw new ImportacionXmlContabilidadError("El XML está vacío.");
  try {
    validarXmlCfdiSeguro(xml);
  } catch (err) {
    throw new ImportacionXmlContabilidadError(err instanceof Error ? err.message : "El XML no es seguro.");
  }
  if (XMLValidator.validate(xml) !== true) throw new ImportacionXmlContabilidadError("El XML está mal formado.");
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new ImportacionXmlContabilidadError("El XML está mal formado.");
  }
  const nombres = Object.keys(doc).filter((k) => !k.startsWith("?"));
  if (nombres.length !== 1) throw new ImportacionXmlContabilidadError("El XML debe tener un solo elemento raíz.");
  const nombreRaiz = nombres[0] as string;
  const raiz = doc[nombreRaiz];
  if (typeof raiz !== "object" || raiz === null) throw new ImportacionXmlContabilidadError("El XML no trae contenido.");
  return { raiz: raiz as Record<string, unknown>, nombreRaiz };
}

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function encabezado(raiz: Record<string, unknown>): { rfc: string; ejercicio: number; mes: number } {
  const rfc = texto(raiz.RFC).toUpperCase();
  if (!RFC_SAT_RE.test(rfc)) throw new ImportacionXmlContabilidadError("El RFC del archivo no tiene el formato del SAT.");
  const version = texto(raiz.Version);
  if (!/^1\.[1-3]$/.test(version)) throw new ImportacionXmlContabilidadError(`Versión de contabilidad electrónica no admitida: ${version || "(sin versión)"}.`);
  const ejercicio = Number(texto(raiz.Anio));
  const mes = Number(texto(raiz.Mes));
  if (!Number.isInteger(ejercicio) || ejercicio < 2014 || ejercicio > 2099) throw new ImportacionXmlContabilidadError("El año del archivo es inválido.");
  if (!Number.isInteger(mes) || mes < 1 || mes > 13) throw new ImportacionXmlContabilidadError("El mes del archivo es inválido.");
  return { rfc, ejercicio, mes };
}

// ---------------------------------------------------------------------------
// Catálogo de cuentas
// ---------------------------------------------------------------------------

export interface CuentaImportada {
  readonly codigo: string;
  readonly descripcion: string;
  readonly naturaleza: "D" | "A";
  readonly nivel: number;
  readonly cuentaPadre: string | null;
  readonly codigoAgrupador: string | null;
}

export interface CuentaRechazada {
  readonly numCta: string;
  readonly motivo: string;
}

export interface CatalogoImportado {
  readonly rfc: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly cuentas: readonly CuentaImportada[];
  readonly rechazadas: readonly CuentaRechazada[];
  /** Avisos que no impiden importar (código agrupador fuera de lista, repetidas...). */
  readonly advertencias: readonly string[];
}

/**
 * Lee el XML de catálogo y separa las cuentas importables de las rechazadas. `existentes` es nivel por código de lo que el cliente YA tiene en el
 * libro (una cuenta puede colgar de una existente). Las cuentas salen ordenadas por nivel (el padre antes que sus subcuentas).
 */
export function leerCatalogoXml(xml: string, existentes: ReadonlyMap<string, number> = new Map()): CatalogoImportado {
  const { raiz, nombreRaiz } = leerSeguro(xml);
  if (nombreRaiz !== "Catalogo") throw new ImportacionXmlContabilidadError("El XML no es un catálogo de cuentas de contabilidad electrónica (raíz Catalogo).");
  const cab = encabezado(raiz);
  const ctas = (Array.isArray(raiz.Ctas) ? raiz.Ctas : []) as Array<Record<string, unknown>>;
  if (ctas.length === 0) throw new ImportacionXmlContabilidadError("El catálogo no trae cuentas.");
  if (ctas.length > MAX_CUENTAS_IMPORTADAS) throw new ImportacionXmlContabilidadError(`El catálogo trae más de ${MAX_CUENTAS_IMPORTADAS} cuentas.`);

  const rechazadas: CuentaRechazada[] = [];
  const advertencias: string[] = [];
  const candidatas = new Map<string, CuentaImportada>();
  let repetidas = 0;
  let codigosFueraDeLista = 0;
  for (const c of ctas) {
    const numCta = texto(c.NumCta);
    const rechazar = (motivo: string): void => {
      rechazadas.push({ numCta: numCta.slice(0, 100), motivo });
    };
    if (!/^\d{4,10}$/.test(numCta)) {
      rechazar("El número de cuenta no es numérico de 4 a 10 dígitos: este libro solo maneja cuentas numéricas (renumérala en el sistema anterior o captúrala a mano).");
      continue;
    }
    const descripcion = texto(c.Desc).slice(0, 200);
    if (descripcion === "") {
      rechazar("La cuenta no trae descripción.");
      continue;
    }
    const natur = texto(c.Natur).toUpperCase();
    if (natur !== "D" && natur !== "A") {
      rechazar("Naturaleza inválida (se esperaba D o A).");
      continue;
    }
    const nivel = Number(texto(c.Nivel));
    if (!Number.isInteger(nivel) || nivel < 1 || nivel > 10) {
      rechazar("Nivel inválido (de 1 a 10).");
      continue;
    }
    const padreCrudo = texto(c.SubCtaDe);
    if (nivel === 1 && padreCrudo !== "") {
      rechazar("Una cuenta de nivel 1 no lleva cuenta padre.");
      continue;
    }
    if (nivel > 1 && padreCrudo === "") {
      rechazar("Una cuenta de nivel mayor a 1 debe indicar su cuenta padre (SubCtaDe).");
      continue;
    }
    const cod = texto(c.CodAgrup);
    let codigoAgrupador: string | null = null;
    if (cod !== "") {
      if (esCodigoAgrupadorSat(cod)) codigoAgrupador = cod;
      else codigosFueraDeLista += 1;
    }
    if (candidatas.has(numCta)) repetidas += 1;
    candidatas.set(numCta, { codigo: numCta, descripcion, naturaleza: natur, nivel, cuentaPadre: nivel > 1 ? padreCrudo : null, codigoAgrupador });
  }

  // Resolver jerarquía en orden de nivel: una subcuenta se acepta solo si su padre se aceptó (o ya existe en el libro) con nivel inmediato superior.
  const aceptadas = new Map<string, CuentaImportada>();
  const ordenadas = [...candidatas.values()].sort((a, b) => a.nivel - b.nivel || a.codigo.localeCompare(b.codigo));
  for (const c of ordenadas) {
    if (c.cuentaPadre !== null) {
      const nivelPadre = aceptadas.get(c.cuentaPadre)?.nivel ?? existentes.get(c.cuentaPadre);
      if (nivelPadre === undefined) {
        rechazadas.push({ numCta: c.codigo, motivo: `Su cuenta padre ${c.cuentaPadre} no está en el archivo (o fue rechazada) ni en el catálogo del cliente.` });
        continue;
      }
      if (nivelPadre !== c.nivel - 1) {
        rechazadas.push({ numCta: c.codigo, motivo: `Su cuenta padre ${c.cuentaPadre} debe ser de nivel ${c.nivel - 1}.` });
        continue;
      }
      if (c.cuentaPadre.charAt(0) !== c.codigo.charAt(0)) {
        rechazadas.push({ numCta: c.codigo, motivo: "Su cuenta padre debe ser del mismo rubro (primer dígito)." });
        continue;
      }
    }
    aceptadas.set(c.codigo, c);
  }
  if (repetidas > 0) advertencias.push(`${repetidas} cuenta(s) repetida(s) en el archivo: se tomó la última aparición.`);
  if (codigosFueraDeLista > 0) advertencias.push(`${codigosFueraDeLista} cuenta(s) traen un código agrupador que no está en la lista del Anexo 24: se importan sin código para que lo asignes.`);
  return { ...cab, cuentas: [...aceptadas.values()], rechazadas, advertencias };
}

// ---------------------------------------------------------------------------
// Balanza de comprobación
// ---------------------------------------------------------------------------

export interface LineaBalanzaImportada {
  readonly numCta: string;
  readonly saldoInicialCentavos: number;
  readonly debeCentavos: number;
  readonly haberCentavos: number;
  readonly saldoFinalCentavos: number;
}

export interface BalanzaImportada {
  readonly rfc: string;
  readonly ejercicio: number;
  readonly mes: number;
  readonly tipoEnvio: "N" | "C";
  readonly lineas: readonly LineaBalanzaImportada[];
}

/** "1234.56" / "-12.3" / "5" -> centavos enteros exactos; null si no es un importe de a lo más 2 decimales. */
export function importeACentavos(valor: string): number | null {
  const m = /^(-)?(\d{1,15})(?:\.(\d{1,2}))?$/.exec(valor.trim());
  if (!m) return null;
  const enteros = Number(m[2]);
  const centavos = m[3] === undefined ? 0 : Number(m[3].padEnd(2, "0"));
  const total = enteros * 100 + centavos;
  if (!Number.isSafeInteger(total)) return null;
  return m[1] ? -total : total;
}

export function leerBalanzaXml(xml: string): BalanzaImportada {
  const { raiz, nombreRaiz } = leerSeguro(xml);
  if (nombreRaiz !== "Balanza") throw new ImportacionXmlContabilidadError("El XML no es una balanza de comprobación de contabilidad electrónica (raíz Balanza).");
  const cab = encabezado(raiz);
  const tipo = texto(raiz.TipoEnvio).toUpperCase();
  if (tipo !== "N" && tipo !== "C") throw new ImportacionXmlContabilidadError("TipoEnvio de la balanza inválido (N o C).");
  const ctas = (Array.isArray(raiz.Ctas) ? raiz.Ctas : []) as Array<Record<string, unknown>>;
  if (ctas.length === 0) throw new ImportacionXmlContabilidadError("La balanza no trae cuentas.");
  if (ctas.length > MAX_CUENTAS_IMPORTADAS) throw new ImportacionXmlContabilidadError(`La balanza trae más de ${MAX_CUENTAS_IMPORTADAS} cuentas.`);
  const lineas: LineaBalanzaImportada[] = ctas.map((c, i) => {
    const numCta = texto(c.NumCta);
    const importes = [importeACentavos(texto(c.SaldoIni)), importeACentavos(texto(c.Debe)), importeACentavos(texto(c.Haber)), importeACentavos(texto(c.SaldoFin))];
    if (numCta === "" || importes.some((x) => x === null)) throw new ImportacionXmlContabilidadError(`La cuenta ${i + 1} de la balanza trae un importe o número de cuenta inválido.`);
    return { numCta, saldoInicialCentavos: importes[0] as number, debeCentavos: importes[1] as number, haberCentavos: importes[2] as number, saldoFinalCentavos: importes[3] as number };
  });
  return { ...cab, tipoEnvio: tipo, lineas };
}

export interface PartidaApertura {
  readonly cuenta: string;
  readonly debeCentavos: number;
  readonly haberCentavos: number;
}

export type ResultadoApertura =
  | { readonly ok: true; readonly fecha: string; readonly partidas: readonly PartidaApertura[]; readonly totalCentavos: number }
  | { readonly ok: false; readonly motivo: string; readonly cuentasFaltantes?: readonly string[] };

/** Último día del mes anterior al periodo de la balanza (la apertura es el saldo inicial de ese mes). */
export function fechaAperturaDe(ejercicio: number, mes: number): string {
  const ultimo = new Date(Date.UTC(ejercicio, mes - 1, 0));
  return ultimo.toISOString().slice(0, 10);
}

/**
 * Póliza de apertura (diario) con los SALDOS INICIALES de la balanza importada: cada saldo va del lado de la naturaleza de su cuenta (deudora positiva =
 * debe; acreedora positiva = haber; el saldo con signo contrario se invierte). Solo sale si todas las cuentas con saldo existen en el catálogo del
 * cliente, si la balanza cuadra (suma de saldos deudores = suma de acreedores) y si cabe en una póliza (<= 200 partidas): nunca se recorta ni se inventa.
 */
export function construirAperturaDesdeBalanza(b: BalanzaImportada, naturalezas: ReadonlyMap<string, "D" | "A">): ResultadoApertura {
  if (b.mes < 1 || b.mes > 12) return { ok: false, motivo: "El mes 13 (ajustes) no abre un periodo: importa la balanza de un mes del 1 al 12." };
  const conSaldo = b.lineas.filter((l) => l.saldoInicialCentavos !== 0);
  if (conSaldo.length === 0) return { ok: false, motivo: "La balanza no trae saldos iniciales: no hay póliza de apertura que registrar." };
  const faltantes = conSaldo.filter((l) => !naturalezas.has(l.numCta)).map((l) => l.numCta);
  if (faltantes.length > 0) return { ok: false, motivo: "Hay cuentas con saldo que no existen en el catálogo del cliente: importa primero su catálogo.", cuentasFaltantes: faltantes.slice(0, 50) };
  const partidas: PartidaApertura[] = [];
  const acumulado = new Map<string, number>();
  for (const l of conSaldo) acumulado.set(l.numCta, (acumulado.get(l.numCta) ?? 0) + l.saldoInicialCentavos);
  for (const [cuenta, saldo] of acumulado) {
    if (saldo === 0) continue;
    const nat = naturalezas.get(cuenta) as "D" | "A";
    const enDebe = (nat === "D") === (saldo > 0);
    partidas.push({ cuenta, debeCentavos: enDebe ? Math.abs(saldo) : 0, haberCentavos: enDebe ? 0 : Math.abs(saldo) });
  }
  const debe = partidas.reduce((s, p) => s + p.debeCentavos, 0);
  const haber = partidas.reduce((s, p) => s + p.haberCentavos, 0);
  if (!Number.isSafeInteger(debe) || !Number.isSafeInteger(haber)) return { ok: false, motivo: "Los saldos exceden el rango permitido." };
  if (debe !== haber) return { ok: false, motivo: `La balanza importada no cuadra: saldos deudores ${debe} y acreedores ${haber} centavos.` };
  if (partidas.length < 2) return { ok: false, motivo: "La apertura necesita al menos dos cuentas con saldo." };
  if (partidas.length > MAX_PARTIDAS_APERTURA) return { ok: false, motivo: `La apertura trae ${partidas.length} cuentas con saldo y una póliza admite hasta ${MAX_PARTIDAS_APERTURA}: regístrala por partes.` };
  partidas.sort((a, b) => a.cuenta.localeCompare(b.cuenta));
  return { ok: true, fecha: fechaAperturaDe(b.ejercicio, b.mes), partidas, totalCentavos: debe };
}

export { CFDI_XML_MAX_CARACTERES as MAX_CARACTERES_XML_CONTABILIDAD };
