// Importacion de cartera de clientes -- lectura de CSV/Excel EN EL NAVEGADOR, mapeo asistido de columnas y huella del archivo.
// El servidor (POST .../admin/customers/import[/preview]) es la autoridad: normaliza los telefonos con las mismas reglas que el resto de
// canales (10 digitos; +52 y 521 se aceptan; 11 digitos se rechaza) y la base vuelve a validar. Aqui solo se leen celdas y se arman
// los renglones crudos; nada se manda hasta que la persona lo confirma. No dispara mensajes a nadie.
import { unzipSync } from "fflate";

/** Mismo tope que el servidor (`IMPORTACION_MAX_FILAS`). */
export const IMPORTACION_MAX_FILAS = 5000;
/** Un archivo mas grande no es una cartera de clientes: se rechaza antes de leerlo. */
export const IMPORTACION_MAX_BYTES = 5 * 1024 * 1024;

export const CAMPOS_IMPORTACION = ["telefono", "nombre", "direccion", "colonia", "notas"] as const;
export type CampoImportacion = (typeof CAMPOS_IMPORTACION)[number];

export const ETIQUETA_CAMPO: Readonly<Record<CampoImportacion, string>> = {
  telefono: "Teléfono",
  nombre: "Nombre",
  direccion: "Dirección",
  colonia: "Colonia",
  notas: "Notas",
};

/** Indice de columna (0-based) por campo; `null` = no importar ese dato. */
export type MapeoColumnas = Readonly<Record<CampoImportacion, number | null>>;

export interface FilaCruda {
  readonly telefono: string;
  readonly nombre: string;
  readonly direccion: string;
  readonly colonia: string;
  readonly notas: string;
}

export class ArchivoImportacionError extends Error {}

// ---- CSV ------------------------------------------------------------------------------------------------------------------------

function detectarSeparador(muestra: string): string {
  const primera = muestra.split(/\r?\n/, 1)[0] ?? "";
  const cuenta = (c: string) => primera.split(c).length - 1;
  const candidatos: Array<[string, number]> = [
    [",", cuenta(",")],
    [";", cuenta(";")],
    ["\t", cuenta("\t")],
  ];
  candidatos.sort((a, b) => b[1] - a[1]);
  return candidatos[0]![1] > 0 ? candidatos[0]![0] : ",";
}

/** CSV con comillas (RFC 4180): comillas dobles escapadas, saltos de linea dentro de una celda, separador `,` `;` o tabulador, BOM. */
export function parsearCsv(texto: string): string[][] {
  const t = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
  const sep = detectarSeparador(t);
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let enComillas = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i]!;
    if (enComillas) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          celda += '"';
          i += 1;
        } else enComillas = false;
      } else celda += ch;
    } else if (ch === '"' && celda === "") {
      enComillas = true;
    } else if (ch === sep) {
      fila.push(celda);
      celda = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i += 1;
      fila.push(celda);
      celda = "";
      filas.push(fila);
      fila = [];
    } else celda += ch;
  }
  if (celda !== "" || fila.length > 0) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas.filter((f) => f.some((c) => c.trim() !== ""));
}

// ---- XLSX (primera hoja) ---------------------------------------------------------------------------------------------------------

function textoDeNodo(el: Element | null): string {
  return el?.textContent ?? "";
}

/** Elementos por NOMBRE LOCAL en cualquier espacio de nombres: `<row>` y `<x:row>` (OpenXML SDK / exportaciones .NET) son lo mismo. */
function porNombre(raiz: Document | Element, nombre: string): Element[] {
  return Array.from(raiz.getElementsByTagNameNS("*", nombre));
}

function indiceDeColumna(ref: string): number {
  const letras = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? "A";
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Primera hoja de un .xlsx: celdas de texto compartido, texto en linea y numeros (un telefono guardado como numero se lee entero). */
export function parsearXlsx(bytes: Uint8Array): string[][] {
  let archivos: Record<string, Uint8Array>;
  try {
    archivos = unzipSync(bytes, { filter: (f) => /^xl\/(sharedStrings\.xml|worksheets\/sheet1\.xml|workbook\.xml)$/.test(f.name) });
  } catch {
    throw new ArchivoImportacionError("No se pudo abrir el archivo de Excel (.xlsx). Guárdalo de nuevo como .xlsx o expórtalo a CSV.");
  }
  const hoja = archivos["xl/worksheets/sheet1.xml"];
  if (!hoja) throw new ArchivoImportacionError("El archivo de Excel no tiene una primera hoja legible. Expórtalo a CSV.");
  const decodificar = (u: Uint8Array) => new TextDecoder("utf-8").decode(u);
  const parser = new DOMParser();
  const compartidas: string[] = [];
  const sst = archivos["xl/sharedStrings.xml"];
  if (sst) {
    const doc = parser.parseFromString(decodificar(sst), "application/xml");
    for (const si of porNombre(doc, "si")) {
      compartidas.push(
        porNombre(si, "t")
          .map((t) => t.textContent ?? "")
          .join(""),
      );
    }
  }
  const doc = parser.parseFromString(decodificar(hoja), "application/xml");
  const filas: string[][] = [];
  for (const row of porNombre(doc, "row")) {
    const fila: string[] = [];
    for (const c of porNombre(row, "c")) {
      const col = indiceDeColumna(c.getAttribute("r") ?? "A1");
      const tipo = c.getAttribute("t");
      let valor = "";
      if (tipo === "s") valor = compartidas[Number(textoDeNodo(porNombre(c, "v")[0] ?? null))] ?? "";
      else if (tipo === "inlineStr") valor = porNombre(c, "t").map((t) => t.textContent ?? "").join("");
      else valor = textoDeNodo(porNombre(c, "v")[0] ?? null);
      while (fila.length < col) fila.push("");
      fila[col] = valor;
    }
    filas.push(fila);
  }
  return filas.filter((f) => f.some((c) => c.trim() !== ""));
}

// ---- Lectura del archivo y huella -------------------------------------------------------------------------------------------------

/** SHA-256 en hexadecimal minusculas de los bytes del archivo (la llave de idempotencia de la importacion). */
export async function huellaSha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Huella de UNA importacion: el archivo + el mapeo de columnas con que se importa (QA R2 caos-07). El mismo archivo con otro mapeo es otra importacion:
 * asi se puede corregir un mapeo equivocado reimportando, y el mismo archivo con el MISMO mapeo sigue siendo idempotente.
 */
export async function huellaConMapeo(huellaArchivo: string, mapeo: MapeoColumnas): Promise<string> {
  const bytes = new TextEncoder().encode(`${huellaArchivo}|${CAMPOS_IMPORTACION.map((c) => `${c}=${mapeo[c] ?? "-"}`).join(",")}`);
  return huellaSha256(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export interface ArchivoLeido {
  readonly nombre: string;
  readonly huella: string;
  /** Todas las filas, encabezado incluido. */
  readonly filas: string[][];
}

/**
 * Texto de un CSV: UTF-8 estricto y, si los bytes no son UTF-8 valido (el "CSV (delimitado por comas)" de Excel en espanol de Windows
 * guarda Windows-1252: "Jose" con acento es un solo byte 0xE9), se lee como Windows-1252. Nunca deja pasar el caracter de reemplazo en
 * silencio: la importacion no pisa un nombre ya conocido y un nombre corrupto seria permanente.
 */
export function decodificarTexto(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

export async function leerArchivoClientes(file: File): Promise<ArchivoLeido> {
  if (file.size > IMPORTACION_MAX_BYTES) throw new ArchivoImportacionError(`El archivo pesa más de ${IMPORTACION_MAX_BYTES / (1024 * 1024)} MB: divídelo en partes.`);
  const buffer = await file.arrayBuffer();
  const huella = await huellaSha256(buffer);
  const nombre = file.name;
  let filas: string[][];
  if (/\.xlsx$/i.test(nombre)) filas = parsearXlsx(new Uint8Array(buffer));
  else if (/\.(csv|txt|tsv)$/i.test(nombre) || /text\//i.test(file.type)) filas = parsearCsv(decodificarTexto(buffer));
  else throw new ArchivoImportacionError("Formato no admitido: sube un .csv o un .xlsx. (Un .xls antiguo: guárdalo como .xlsx o CSV.)");
  if (filas.length === 0) throw new ArchivoImportacionError("El archivo está vacío.");
  return { nombre, huella, filas };
}

// ---- Mapeo asistido ---------------------------------------------------------------------------------------------------------------

function normalizarEncabezado(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

const PATRONES: Readonly<Record<CampoImportacion, RegExp>> = {
  telefono: /(tel|cel|movil|whats|phone|numero)/,
  nombre: /(nombre|name|cliente|contacto)/,
  direccion: /(direcc|domicilio|calle|address)/,
  colonia: /(colonia|barrio|fracc|zona)/,
  notas: /(nota|coment|observ|alergi|preferenc)/,
};

/** Sugiere la columna de cada campo por el nombre del encabezado; cada columna se usa una sola vez. */
export function sugerirMapeo(encabezados: readonly string[]): MapeoColumnas {
  const usadas = new Set<number>();
  const resultado: Record<CampoImportacion, number | null> = { telefono: null, nombre: null, direccion: null, colonia: null, notas: null };
  const normalizados = encabezados.map(normalizarEncabezado);
  for (const campo of CAMPOS_IMPORTACION) {
    const idx = normalizados.findIndex((h, i) => !usadas.has(i) && PATRONES[campo].test(h));
    if (idx >= 0) {
      resultado[campo] = idx;
      usadas.add(idx);
    }
  }
  return resultado;
}

/** Arma los renglones crudos desde las filas de datos (sin encabezado) segun el mapeo. */
export function construirFilas(filasDatos: readonly (readonly string[])[], mapeo: MapeoColumnas): FilaCruda[] {
  const celda = (fila: readonly string[], idx: number | null) => (idx === null ? "" : (fila[idx] ?? "").trim());
  return filasDatos.map((f) => ({
    telefono: celda(f, mapeo.telefono),
    nombre: celda(f, mapeo.nombre),
    direccion: celda(f, mapeo.direccion),
    colonia: celda(f, mapeo.colonia),
    notas: celda(f, mapeo.notas),
  }));
}
