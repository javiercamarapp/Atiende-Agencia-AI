// ═══════════════════════════════════════════════════════════════════════════
// D-13 — lector de ZIP con defensa anti zip-bomb para `POST .../cfdi/importar-lote`. Sin dependencias: lee el directorio central
// (nunca fía de los encabezados locales) y descomprime cada entrada con `zlib.inflateRawSync` y `maxOutputLength`, así que la
// memoria usada queda acotada por los topes de abajo AUNQUE el ZIP mienta en los tamaños que declara.
//
// Un ZIP que viola cualquiera de los topes se rechaza COMPLETO (`ZipCfdiInvalidoError`): no se procesa nada de él. Un archivo
// que simplemente no es un XML de CFDI (otra extensión, XML mal formado) NO invalida el ZIP: se reporta por archivo.
//
// Topes (todos verificados ANTES de descomprimir cuando la cabecera alcanza, y otra vez contra los bytes reales al inflar):
//  - tamaño del ZIP (el llamador lo acota con el cuerpo de la petición, 4 MB: límite de las funciones de Vercel),
//  - entradas totales del directorio central, y entradas XML a procesar (MAX_ARCHIVOS_LOTE),
//  - tamaño descomprimido por archivo y en total,
//  - razón de compresión por archivo (una factura real comprime ~5-12x; una bomba, miles de veces),
//  - rutas con `..` como segmento, absolutas, con `\`, con NUL o letra de unidad; entradas duplicadas,
//  - ZIP anidado (por extensión o por la firma `PK\x03\x04` del contenido), cifrado, ZIP64, multi-disco o método distinto de
//    stored/deflate.
// ═══════════════════════════════════════════════════════════════════════════
import { inflateRawSync } from "node:zlib";
import { MAX_ARCHIVOS_LOTE } from "@atiende/domain-despachos";

export const LIMITES_ZIP_CFDI = {
  /** Tamaño máximo del ZIP recibido (límite de cuerpo de las funciones de Vercel). */
  maxBytesZip: 4 * 1024 * 1024,
  /** Entradas del directorio central (incluye carpetas y basura de macOS). */
  maxEntradas: 200,
  /** XML a procesar por ZIP. */
  maxXml: MAX_ARCHIVOS_LOTE,
  /** Mismo tope que un XML suelto (`MAX_CFDI_XML_BYTES` de cfdi.ts). */
  maxBytesPorArchivo: 512 * 1024,
  maxBytesTotal: 20 * 1024 * 1024,
  /** Razón descomprimido/comprimido máxima, solo para entradas de más de `umbralRazonBytes`. */
  maxRazonCompresion: 100,
  umbralRazonBytes: 8 * 1024,
} as const;

export type LimitesZipCfdi = { -readonly [K in keyof typeof LIMITES_ZIP_CFDI]: number };

export class ZipCfdiInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipCfdiInvalidoError";
  }
}

export interface EntradaXmlZip {
  readonly nombre: string;
  readonly bytes: Uint8Array;
}

export interface LecturaZipCfdi {
  readonly xml: readonly EntradaXmlZip[];
  /** Entradas que no son `.xml` (no se descomprimen): el llamador las reporta como rechazadas. */
  readonly noXml: readonly string[];
  /** Carpetas y basura de sistema (`__MACOSX/`, `._x`, `.DS_Store`): se omiten sin reportarlas. */
  readonly ignorados: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EXTENSIONES_ANIDADAS = /\.(zip|gz|tgz|rar|7z|tar|bz2|xz|jar)$/i;

function rutaInsegura(nombre: string): boolean {
  if (nombre === "" || nombre.includes("\u0000") || nombre.includes("\\") || nombre.startsWith("/") || /^[A-Za-z]:/.test(nombre)) return true;
  return nombre.split("/").some((segmento) => segmento === "..");
}

function esBasura(nombre: string): boolean {
  const partes = nombre.split("/").filter((p) => p !== "");
  const base = partes[partes.length - 1] ?? "";
  return nombre.endsWith("/") || partes[0] === "__MACOSX" || base.startsWith("._") || base === ".DS_Store" || base.toLowerCase() === "thumbs.db";
}

function buscarEocd(dv: DataView): number {
  const minimo = Math.max(0, dv.byteLength - (22 + 0xffff));
  for (let i = dv.byteLength - 22; i >= minimo; i -= 1) {
    if (dv.getUint32(i, true) === SIG_EOCD) return i;
  }
  throw new ZipCfdiInvalidoError("El archivo no es un ZIP válido.");
}

export function leerZipCfdi(bytes: Uint8Array, limites: LimitesZipCfdi = { ...LIMITES_ZIP_CFDI }): LecturaZipCfdi {
  if (bytes.byteLength > limites.maxBytesZip) throw new ZipCfdiInvalidoError(`El ZIP excede ${Math.floor(limites.maxBytesZip / (1024 * 1024))} MB.`);
  if (bytes.byteLength < 22) throw new ZipCfdiInvalidoError("El archivo no es un ZIP válido.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = buscarEocd(dv);
  const discoActual = dv.getUint16(eocd + 4, true);
  const discoCentral = dv.getUint16(eocd + 6, true);
  const entradasTotales = dv.getUint16(eocd + 10, true);
  const tamCentral = dv.getUint32(eocd + 12, true);
  const offCentral = dv.getUint32(eocd + 16, true);
  if (discoActual !== 0 || discoCentral !== 0) throw new ZipCfdiInvalidoError("No se admiten ZIP de varios discos.");
  if (entradasTotales === 0xffff || tamCentral === 0xffffffff || offCentral === 0xffffffff) throw new ZipCfdiInvalidoError("No se admiten ZIP64.");
  if (entradasTotales === 0) throw new ZipCfdiInvalidoError("El ZIP está vacío.");
  if (entradasTotales > limites.maxEntradas) throw new ZipCfdiInvalidoError(`El ZIP trae ${entradasTotales} entradas; el máximo es ${limites.maxEntradas}.`);
  if (offCentral + tamCentral > eocd) throw new ZipCfdiInvalidoError("El directorio central del ZIP está dañado.");

  const xml: EntradaXmlZip[] = [];
  const noXml: string[] = [];
  const vistos = new Set<string>();
  const decodificador = new TextDecoder("utf-8");
  let ignorados = 0;
  let totalReal = 0;
  let p = offCentral;
  for (let n = 0; n < entradasTotales; n += 1) {
    if (p + 46 > eocd || dv.getUint32(p, true) !== SIG_CENTRAL) throw new ZipCfdiInvalidoError("El directorio central del ZIP está dañado.");
    const flags = dv.getUint16(p + 8, true);
    const metodo = dv.getUint16(p + 10, true);
    const tamComprimido = dv.getUint32(p + 20, true);
    const tamDescomprimido = dv.getUint32(p + 24, true);
    const largoNombre = dv.getUint16(p + 28, true);
    const largoExtra = dv.getUint16(p + 30, true);
    const largoComentario = dv.getUint16(p + 32, true);
    const offLocal = dv.getUint32(p + 42, true);
    if (p + 46 + largoNombre + largoExtra + largoComentario > eocd) throw new ZipCfdiInvalidoError("El directorio central del ZIP está dañado.");
    const nombre = decodificador.decode(bytes.subarray(p + 46, p + 46 + largoNombre));
    p += 46 + largoNombre + largoExtra + largoComentario;

    if (rutaInsegura(nombre)) throw new ZipCfdiInvalidoError("El ZIP trae una entrada con ruta no permitida (ruta absoluta, con '..' o con caracteres no válidos).");
    const clave = nombre.toLowerCase();
    if (vistos.has(clave)) throw new ZipCfdiInvalidoError("El ZIP trae entradas con el mismo nombre.");
    vistos.add(clave);
    if (esBasura(nombre)) {
      ignorados += 1;
      continue;
    }
    if (EXTENSIONES_ANIDADAS.test(nombre)) throw new ZipCfdiInvalidoError("No se admiten ZIP ni archivos comprimidos anidados.");
    if ((flags & 1) !== 0) throw new ZipCfdiInvalidoError("No se admiten ZIP cifrados.");
    if (!nombre.toLowerCase().endsWith(".xml")) {
      noXml.push(nombre);
      continue;
    }
    if (xml.length >= limites.maxXml) throw new ZipCfdiInvalidoError(`El ZIP trae más de ${limites.maxXml} archivos XML; divídelo en partes.`);
    if (metodo !== 0 && metodo !== 8) throw new ZipCfdiInvalidoError("El ZIP usa un método de compresión no soportado.");
    if (tamComprimido === 0xffffffff || tamDescomprimido === 0xffffffff) throw new ZipCfdiInvalidoError("No se admiten ZIP64.");
    if (tamDescomprimido > limites.maxBytesPorArchivo) throw new ZipCfdiInvalidoError(`Un archivo del ZIP excede ${Math.floor(limites.maxBytesPorArchivo / 1024)} KB descomprimido.`);
    if (tamDescomprimido > limites.umbralRazonBytes && tamDescomprimido / Math.max(1, tamComprimido) > limites.maxRazonCompresion) {
      throw new ZipCfdiInvalidoError("Un archivo del ZIP tiene una razón de compresión sospechosa; se rechaza el ZIP completo.");
    }
    if (metodo === 0 && tamComprimido !== tamDescomprimido) throw new ZipCfdiInvalidoError("El directorio central del ZIP es incoherente.");
    if (offLocal + 30 > bytes.byteLength || dv.getUint32(offLocal, true) !== SIG_LOCAL) throw new ZipCfdiInvalidoError("El ZIP está dañado (encabezado local inválido).");
    const inicio = offLocal + 30 + dv.getUint16(offLocal + 26, true) + dv.getUint16(offLocal + 28, true);
    if (inicio + tamComprimido > offCentral) throw new ZipCfdiInvalidoError("El ZIP está dañado (datos fuera de rango).");
    const comprimido = bytes.subarray(inicio, inicio + tamComprimido);

    let contenido: Uint8Array;
    if (metodo === 0) {
      contenido = comprimido;
    } else {
      try {
        // `maxOutputLength` corta la inflación en cuanto se pasa de lo declarado: un encabezado que miente no agota memoria.
        contenido = inflateRawSync(comprimido, { maxOutputLength: Math.max(1, tamDescomprimido) });
      } catch {
        throw new ZipCfdiInvalidoError("Un archivo del ZIP está dañado o se descomprime a más de lo que declara.");
      }
    }
    if (contenido.byteLength !== tamDescomprimido) throw new ZipCfdiInvalidoError("Un archivo del ZIP no coincide con el tamaño que declara.");
    totalReal += contenido.byteLength;
    if (totalReal > limites.maxBytesTotal) throw new ZipCfdiInvalidoError(`El ZIP excede ${Math.floor(limites.maxBytesTotal / (1024 * 1024))} MB descomprimido.`);
    if (contenido.byteLength >= 4 && contenido[0] === 0x50 && contenido[1] === 0x4b && contenido[2] === 0x03 && contenido[3] === 0x04) {
      throw new ZipCfdiInvalidoError("No se admiten ZIP anidados.");
    }
    xml.push({ nombre, bytes: contenido });
  }
  if (xml.length === 0 && noXml.length === 0) throw new ZipCfdiInvalidoError("El ZIP no trae archivos.");
  return { xml, noXml, ignorados };
}
