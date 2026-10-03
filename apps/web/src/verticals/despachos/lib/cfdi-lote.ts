// D-13: carga masiva de CFDI desde el navegador. `POST /despachos/:propertyId/cfdi/importar-lote` (apps/api .../cfdi-lote.ts) recibe hasta
// 50 XML por peticion y un cuerpo de hasta 4.5 MB (limite de las funciones de Vercel). Este modulo (sin React, probable con vitest):
//   - descomprime un ZIP EN EL NAVEGADOR (fflate) con los mismos criterios defensivos que el servidor (sin '..', sin anidados, tope de
//     entradas / tamano por archivo / total / razon de compresion): asi un ZIP grande (mayor a 4 MB) o con mas de 50 XML entra en tandas,
//   - parte los archivos en tandas de <= 50 XML y <= 3.5 MB,
//   - las envia en orden y se detiene entre tandas si el usuario cancela (lo ya importado NO se revierte).
// Los tipos espejan la respuesta del servidor (el panel no depende de @atiende/domain-despachos).
import { unzipSync } from "fflate";
import { apiBaseUrlFromRequestUrl, readWriteErrorMessage, withAuthRefresh } from "../../../lib/authed-fetch.ts";
import { DespachosAdminError, despachosAuthContext } from "./admin-client.ts";

export type EstadoArchivoLote = "ingerido" | "en_revision" | "duplicado" | "rechazado";

export interface ResultadoArchivoLote {
  readonly archivo: string;
  readonly estado: EstadoArchivoLote;
  readonly clase: "cfdi" | "rep" | null;
  readonly folioFiscal: string | null;
  readonly motivo: string | null;
}

export interface TotalesLote {
  readonly recibidos: number;
  readonly ingeridos: number;
  readonly enRevision: number;
  readonly duplicados: number;
  readonly rechazados: number;
  readonly reps: number;
}

export interface RespuestaLote {
  readonly loteId: string;
  readonly resultados: readonly ResultadoArchivoLote[];
  readonly totales: TotalesLote;
  readonly ignorados: number;
}

export interface ArchivoParaLote {
  readonly nombre: string;
  readonly bytes: Uint8Array;
}

export const MAX_ARCHIVOS_POR_TANDA = 50;
/** Debajo de los 4.5 MB de cuerpo de Vercel, con margen para el envoltorio multipart. */
export const MAX_BYTES_POR_TANDA = 3.5 * 1024 * 1024;
export const MAX_BYTES_XML = 512 * 1024;

export const LIMITES_ZIP_NAVEGADOR = {
  maxBytesZip: 100 * 1024 * 1024,
  maxEntradas: 5000,
  maxBytesTotal: 256 * 1024 * 1024,
  maxRazonCompresion: 100,
  umbralRazonBytes: 8 * 1024,
} as const;

export class ZipNavegadorError extends Error {}

const EXTENSIONES_ANIDADAS = /\.(zip|gz|tgz|rar|7z|tar|bz2|xz|jar)$/i;

function rutaInsegura(nombre: string): boolean {
  if (nombre === "" || nombre.includes("\u0000") || nombre.includes("\\") || nombre.startsWith("/") || /^[A-Za-z]:/.test(nombre)) return true;
  return nombre.split("/").some((s) => s === "..");
}

function esBasura(nombre: string): boolean {
  const partes = nombre.split("/").filter((p) => p !== "");
  const base = partes[partes.length - 1] ?? "";
  return nombre.endsWith("/") || partes[0] === "__MACOSX" || base.startsWith("._") || base === ".DS_Store" || base.toLowerCase() === "thumbs.db";
}

export interface ZipDescomprimido {
  readonly xml: readonly ArchivoParaLote[];
  /** Entradas que no son .xml: no se envian; se reportan como omitidas en el resumen. */
  readonly noXml: readonly string[];
  readonly ignorados: number;
}

/** Descomprime un ZIP (bytes) con topes. Rechaza el ZIP COMPLETO ante rutas con `..`, anidados o excesos (`ZipNavegadorError`). */
export function descomprimirZip(bytes: Uint8Array, limites: { -readonly [K in keyof typeof LIMITES_ZIP_NAVEGADOR]: number } = { ...LIMITES_ZIP_NAVEGADOR }): ZipDescomprimido {
  if (bytes.byteLength > limites.maxBytesZip) throw new ZipNavegadorError(`El ZIP excede ${Math.floor(limites.maxBytesZip / (1024 * 1024))} MB.`);
  const noXml: string[] = [];
  let ignorados = 0;
  let entradas = 0;
  let totalDeclarado = 0;
  const vistos = new Set<string>();
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, {
      // El filtro corre ANTES de descomprimir cada entrada: lo que no pasa no se infla.
      filter: (f) => {
        entradas += 1;
        if (entradas > limites.maxEntradas) throw new ZipNavegadorError(`El ZIP trae más de ${limites.maxEntradas} entradas.`);
        if (rutaInsegura(f.name)) throw new ZipNavegadorError("El ZIP trae una entrada con ruta no permitida (ruta absoluta, con '..' o con caracteres no válidos).");
        const clave = f.name.toLowerCase();
        if (vistos.has(clave)) throw new ZipNavegadorError("El ZIP trae entradas con el mismo nombre.");
        vistos.add(clave);
        if (esBasura(f.name)) {
          ignorados += 1;
          return false;
        }
        if (EXTENSIONES_ANIDADAS.test(f.name)) throw new ZipNavegadorError("No se admiten ZIP ni archivos comprimidos anidados.");
        if (!f.name.toLowerCase().endsWith(".xml")) {
          noXml.push(f.name);
          return false;
        }
        if (f.originalSize > MAX_BYTES_XML) throw new ZipNavegadorError(`Un archivo del ZIP excede ${MAX_BYTES_XML / 1024} KB descomprimido.`);
        if (f.originalSize > limites.umbralRazonBytes && f.originalSize / Math.max(1, f.size) > limites.maxRazonCompresion) {
          throw new ZipNavegadorError("Un archivo del ZIP tiene una razón de compresión sospechosa; se rechaza el ZIP completo.");
        }
        totalDeclarado += f.originalSize;
        if (totalDeclarado > limites.maxBytesTotal) throw new ZipNavegadorError(`El ZIP excede ${Math.floor(limites.maxBytesTotal / (1024 * 1024))} MB descomprimido.`);
        return true;
      },
    });
  } catch (err) {
    if (err instanceof ZipNavegadorError) throw err;
    throw new ZipNavegadorError("El archivo no es un ZIP válido o está dañado.");
  }
  const xml: ArchivoParaLote[] = [];
  for (const [nombre, contenido] of Object.entries(unzipped)) {
    if (contenido.byteLength > MAX_BYTES_XML) throw new ZipNavegadorError(`Un archivo del ZIP excede ${MAX_BYTES_XML / 1024} KB descomprimido.`);
    if (contenido.byteLength >= 4 && contenido[0] === 0x50 && contenido[1] === 0x4b && contenido[2] === 0x03 && contenido[3] === 0x04) throw new ZipNavegadorError("No se admiten ZIP anidados.");
    xml.push({ nombre, bytes: contenido });
  }
  return { xml, noXml, ignorados };
}

/** Parte los archivos en tandas de <= MAX_ARCHIVOS_POR_TANDA y <= MAX_BYTES_POR_TANDA (un archivo siempre cabe: su tope es 512 KB). */
export function armarTandas(archivos: readonly ArchivoParaLote[], maxArchivos = MAX_ARCHIVOS_POR_TANDA, maxBytes = MAX_BYTES_POR_TANDA): ArchivoParaLote[][] {
  const tandas: ArchivoParaLote[][] = [];
  let actual: ArchivoParaLote[] = [];
  let bytes = 0;
  for (const a of archivos) {
    if (actual.length > 0 && (actual.length >= maxArchivos || bytes + a.bytes.byteLength > maxBytes)) {
      tandas.push(actual);
      actual = [];
      bytes = 0;
    }
    actual.push(a);
    bytes += a.bytes.byteLength;
  }
  if (actual.length > 0) tandas.push(actual);
  return tandas;
}

export function sumarTotales(partes: readonly TotalesLote[]): TotalesLote {
  return partes.reduce<TotalesLote>(
    (acc, t) => ({ recibidos: acc.recibidos + t.recibidos, ingeridos: acc.ingeridos + t.ingeridos, enRevision: acc.enRevision + t.enRevision, duplicados: acc.duplicados + t.duplicados, rechazados: acc.rechazados + t.rechazados, reps: acc.reps + t.reps }),
    { recibidos: 0, ingeridos: 0, enRevision: 0, duplicados: 0, rechazados: 0, reps: 0 },
  );
}

/** `POST /despachos/:propertyId/cfdi/importar-lote` (multipart) con refresh de sesion y reintento ante 401. */
export async function importarLote(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, archivos: readonly ArchivoParaLote[]): Promise<RespuestaLote> {
  const url = `${apiBaseUrl}/despachos/${propertyId}/cfdi/importar-lote`;
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), despachosAuthContext(), token, (t) => {
    // FormData nuevo por intento: un reintento tras refrescar la sesion no reutiliza un cuerpo ya consumido.
    const fd = new FormData();
    for (const a of archivos) fd.append("archivos", new Blob([a.bytes as BlobPart], { type: "application/xml" }), a.nombre);
    return fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${t}` }, body: fd });
  });
  if (!res.ok) throw new DespachosAdminError(await readWriteErrorMessage(res, `No se pudo completar la carga (${res.status}).`));
  return (await res.json()) as RespuestaLote;
}

export interface ProgresoLote {
  readonly tandasHechas: number;
  readonly tandasTotal: number;
  readonly archivosEnviados: number;
  readonly archivosTotal: number;
}

export interface ResumenImportacion {
  readonly resultados: readonly ResultadoArchivoLote[];
  readonly totales: TotalesLote;
  /** Archivos que NO se enviaron (por cancelacion o por un fallo de tanda). */
  readonly sinProcesar: number;
  readonly cancelada: boolean;
  /** Mensaje del fallo que detuvo la importacion, si lo hubo. */
  readonly error: string | null;
}

/**
 * Envia las tandas en orden. Si `estaCancelado()` es true ANTES de enviar una tanda, se detiene: las tandas ya enviadas NO se revierten
 * (cada una es una transaccion confirmada en el servidor) y el resumen lo dice. Un fallo de red/servidor en una tanda tambien detiene el
 * resto y se informa; como el servidor es idempotente por UUID, reintentar el mismo lote solo importa lo pendiente.
 */
export async function ejecutarImportacion(
  tandas: readonly (readonly ArchivoParaLote[])[],
  enviar: (tanda: readonly ArchivoParaLote[]) => Promise<RespuestaLote>,
  estaCancelado: () => boolean,
  alProgresar: (p: ProgresoLote) => void,
): Promise<ResumenImportacion> {
  const archivosTotal = tandas.reduce((s, t) => s + t.length, 0);
  const resultados: ResultadoArchivoLote[] = [];
  const totales: TotalesLote[] = [];
  let enviados = 0;
  let cancelada = false;
  let error: string | null = null;
  alProgresar({ tandasHechas: 0, tandasTotal: tandas.length, archivosEnviados: 0, archivosTotal });
  for (let i = 0; i < tandas.length; i += 1) {
    if (estaCancelado()) {
      cancelada = true;
      break;
    }
    try {
      const r = await enviar(tandas[i]!);
      resultados.push(...r.resultados);
      totales.push(r.totales);
      enviados += tandas[i]!.length;
    } catch (err) {
      error = err instanceof Error ? err.message : "No se pudo enviar la tanda.";
      break;
    }
    alProgresar({ tandasHechas: i + 1, tandasTotal: tandas.length, archivosEnviados: enviados, archivosTotal });
  }
  return { resultados, totales: sumarTotales(totales), sinProcesar: archivosTotal - enviados, cancelada, error };
}
