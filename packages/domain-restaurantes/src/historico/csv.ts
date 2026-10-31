// Lector CSV minimo (RFC 4180) para el importador de historial: comillas dobles, comas o punto y coma, saltos CRLF/LF y BOM.
// Puro, sin dependencias. Devuelve renglones como objetos con los encabezados normalizados (minusculas, sin acentos, sin espacios).
import { sinAcentos } from "../product-search.ts";

export class ArchivoHistoricoInvalidoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchivoHistoricoInvalidoError";
  }
}

/** Tope duro de renglones por archivo (la memoria de la Mac es de 8 GB; la base real son ~500). */
export const HISTORICO_MAX_FILAS = 20000;

export function normalizarEncabezado(h: string): string {
  return sinAcentos(h).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function detectarSeparador(primeraLinea: string): "," | ";" | "\t" {
  const cuenta = (c: string) => primeraLinea.split(c).length - 1;
  const opciones: Array<["," | ";" | "\t", number]> = [
    [",", cuenta(",")],
    [";", cuenta(";")],
    ["\t", cuenta("\t")],
  ];
  opciones.sort((a, b) => b[1] - a[1]);
  return opciones[0]![1] > 0 ? opciones[0]![0] : ",";
}

/** Celdas de un CSV completo (matriz). */
export function parsearCsvCrudo(texto: string): string[][] {
  const t = texto.replace(/^\uFEFF/, "");
  const sep = detectarSeparador(t.split(/\r?\n/, 1)[0] ?? "");
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let enComillas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (enComillas) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          celda += '"';
          i++;
        } else enComillas = false;
      } else celda += c;
      continue;
    }
    if (c === '"') enComillas = true;
    else if (c === sep) {
      fila.push(celda);
      celda = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      fila.push(celda);
      celda = "";
      if (fila.some((x) => x.trim() !== "")) filas.push(fila);
      fila = [];
    } else celda += c;
  }
  if (enComillas) throw new ArchivoHistoricoInvalidoError("CSV con comillas sin cerrar.");
  fila.push(celda);
  if (fila.some((x) => x.trim() !== "")) filas.push(fila);
  return filas;
}

/** CSV con encabezado -> renglones como objetos. Los encabezados repetidos se rechazan (ambiguo). */
export function parsearCsvHistorico(texto: string): Array<Record<string, string>> {
  const matriz = parsearCsvCrudo(texto);
  if (matriz.length === 0) return [];
  const encabezados = matriz[0]!.map(normalizarEncabezado);
  if (new Set(encabezados).size !== encabezados.length) throw new ArchivoHistoricoInvalidoError("Encabezados repetidos en el CSV.");
  if (matriz.length - 1 > HISTORICO_MAX_FILAS) throw new ArchivoHistoricoInvalidoError(`El archivo excede ${HISTORICO_MAX_FILAS} renglones.`);
  return matriz.slice(1).map((celdas) => {
    const o: Record<string, string> = {};
    encabezados.forEach((h, i) => {
      if (h !== "") o[h] = (celdas[i] ?? "").trim();
    });
    return o;
  });
}

/** JSON: arreglo de objetos o `{ filas|clientes|pedidos: [...] }`. Las llaves se normalizan igual que los encabezados del CSV. */
export function parsearJsonHistorico(texto: string): Array<Record<string, unknown>> {
  let datos: unknown;
  try {
    datos = JSON.parse(texto.replace(/^\uFEFF/, ""));
  } catch {
    throw new ArchivoHistoricoInvalidoError("JSON invalido.");
  }
  const arreglo = Array.isArray(datos)
    ? datos
    : datos !== null && typeof datos === "object"
      ? ((datos as Record<string, unknown>).filas ?? (datos as Record<string, unknown>).clientes ?? (datos as Record<string, unknown>).pedidos)
      : undefined;
  if (!Array.isArray(arreglo)) throw new ArchivoHistoricoInvalidoError("Se esperaba un arreglo de objetos.");
  if (arreglo.length > HISTORICO_MAX_FILAS) throw new ArchivoHistoricoInvalidoError(`El archivo excede ${HISTORICO_MAX_FILAS} renglones.`);
  return arreglo.map((e) => {
    const o: Record<string, unknown> = {};
    if (e !== null && typeof e === "object" && !Array.isArray(e)) for (const [k, v] of Object.entries(e as Record<string, unknown>)) o[normalizarEncabezado(k)] = v;
    return o;
  });
}

/** Elige el lector por contenido (primer caracter util `[`/`{` = JSON). */
export function parsearArchivoHistorico(texto: string): Array<Record<string, unknown>> {
  const inicio = texto.replace(/^\uFEFF/, "").trimStart()[0];
  return inicio === "[" || inicio === "{" ? parsearJsonHistorico(texto) : parsearCsvHistorico(texto);
}
