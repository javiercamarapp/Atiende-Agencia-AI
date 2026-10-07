// Analisis de archivos adjuntos del Copiloto ("Adjuntar archivo", CSV / Excel / PDF), seguimiento de CHAT-17. FUNCIONES PURAS (sin red ni base): reciben los bytes y
// devuelven una respuesta con la forma de `DataChatAnswer` que el chat ya sabe pintar. El procesamiento ocurre en el servidor del Copiloto; el archivo NO se guarda.
//
// Que hace (todo determinista, sin modelo): CSV y Excel (.xlsx, primera hoja) -> perfil por columna (con dato, distintos, suma, promedio, minimo, maximo); PDF con
// capa de texto -> paginas, caracteres y palabras (+ un extracto con datos de contacto redactados). Lo que NO hace: OCR (un PDF escaneado se declara como tal),
// formulas de Excel (se lee el ultimo valor guardado), ni responder preguntas libres sobre el contenido (decision de producto pendiente, ver docs).
//
// Datos personales: el archivo lo trae la propia persona, pero el chat sigue la regla de la plataforma (agregados por defecto): una columna cuyo encabezado o cuyos
// valores parecen datos personales (nombre, telefono, correo, direccion, RFC...) se reporta SOLO como "personal" con su conteo de celdas con dato; nunca se
// listan valores, ni distintos, ni sumas. Ninguna fila del archivo viaja en la respuesta.
import { redactPii } from "@atiende/agent-core/data-chat";
import { extractDocumentText } from "@atiende/domain-licitaciones";
import JSZip from "jszip";

export const ADJUNTO_MAX_BYTES = 5 * 1024 * 1024;
export const ADJUNTO_MAX_FILAS = 50_000;
export const ADJUNTO_MAX_COLUMNAS = 200;
const XLSX_MAX_XML_BYTES = 30_000_000;
const MAX_FILAS_TABLA = 50;
const EXTRACTO_PDF_CHARS = 600;

export type AdjuntoTipo = "csv" | "xlsx" | "pdf";

export interface AdjuntoColumna {
  readonly key: string;
  readonly label: string;
  readonly kind: "text" | "integer" | "mxn" | "percent" | "decimal";
}

export interface AdjuntoBloque {
  readonly kind: "table";
  readonly tool: "archivo_adjunto";
  readonly title: string;
  readonly columns: readonly AdjuntoColumna[];
  readonly rows: readonly Readonly<Record<string, string | number | null>>[];
  readonly truncated: boolean;
}

export interface AdjuntoRespuesta {
  readonly status: "ok" | "empty";
  readonly text: string;
  readonly blocks: readonly AdjuntoBloque[];
  readonly sources: readonly { readonly tool: "archivo_adjunto"; readonly source: string; readonly scopeLabel: string }[];
  readonly toolsUsed: readonly string[];
}

export type ResultadoAdjunto =
  | { readonly ok: true; readonly tipo: AdjuntoTipo; readonly filas: number; readonly respuesta: AdjuntoRespuesta }
  /** `status` siempre `invalid_input`: el chat muestra su `motivo` tal cual (el aviso generico de `unavailable` ocultaria la razon real). */
  | { readonly ok: false; readonly status: "invalid_input"; readonly motivo: string };

export function tipoDeAdjunto(nombre: string, bytes: Uint8Array): AdjuntoTipo | null {
  const n = nombre.toLowerCase();
  const esPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // "%PDF": manda el contenido, no la extension
  const esZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (esPdf) return "pdf";
  if (n.endsWith(".xlsx")) return esZip ? "xlsx" : null;
  if (/\.(csv|tsv|txt)$/.test(n)) return esZip ? null : "csv";
  return null;
}

const miles = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const redondear = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------------------------------------

function detectarSeparador(primeraLinea: string): string {
  let mejor = ",";
  let max = 0;
  for (const sep of [",", ";", "\t", "|"]) {
    let dentro = false;
    let n = 0;
    for (const ch of primeraLinea) {
      if (ch === '"') dentro = !dentro;
      else if (ch === sep && !dentro) n++;
    }
    if (n > max) {
      max = n;
      mejor = sep;
    }
  }
  return mejor;
}

export function parsearCsv(texto: string): string[][] {
  const limpio = texto.replace(/^\uFEFF/, "");
  const sep = detectarSeparador(limpio.split(/\r?\n/, 1)[0] ?? "");
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let comillas = false;
  const cerrarFila = (): void => {
    fila.push(celda);
    celda = "";
    if (fila.length > 1 || (fila[0] ?? "").trim() !== "") filas.push(fila);
    fila = [];
  };
  for (let i = 0; i < limpio.length; i++) {
    const ch = limpio[i]!;
    if (comillas) {
      if (ch === '"') {
        if (limpio[i + 1] === '"') {
          celda += '"';
          i++;
        } else comillas = false;
      } else celda += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === sep) {
      fila.push(celda);
      celda = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && limpio[i + 1] === "\n") i++;
      cerrarFila();
      if (filas.length > ADJUNTO_MAX_FILAS + 1) throw new LimiteAdjunto(`El archivo tiene más de ${miles(ADJUNTO_MAX_FILAS)} filas.`);
    } else celda += ch;
  }
  if (celda !== "" || fila.length > 0) cerrarFila();
  return filas;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Excel (.xlsx = zip de XML; primera hoja, ultimo valor guardado de cada celda)
// ---------------------------------------------------------------------------------------------------------------------------

class LimiteAdjunto extends Error {}

function decodificarXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&amp;/g, "&");
}

function textoDeSi(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodificarXml(m[1] ?? "");
  return out;
}

function columnaDe(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Parte de la API de flujos de JSZip (`internalStream`) que se usa: existe en tiempo de ejecucion pero no en sus tipos publicos. */
interface FlujoJszip {
  on(evento: "data", cb: (trozo: Uint8Array) => void): FlujoJszip;
  on(evento: "error", cb: (e: Error) => void): FlujoJszip;
  on(evento: "end", cb: () => void): FlujoJszip;
  pause(): FlujoJszip;
  resume(): FlujoJszip;
}

/** Descomprime una entrada del zip por trozos y CORTA al pasar el tope: un zip pequeno que se expande a gigabytes ("bomba") nunca llena la memoria (el tamano declarado en el zip no se usa: puede mentir). */
function leerAcotado(entrada: JSZip.JSZipObject): Promise<string> {
  return new Promise((resolve, reject) => {
    const trozos: Uint8Array[] = [];
    let total = 0;
    const flujo = (entrada as unknown as { internalStream(tipo: "uint8array"): FlujoJszip }).internalStream("uint8array");
    flujo
      .on("data", (trozo: Uint8Array) => {
        total += trozo.length;
        if (total > XLSX_MAX_XML_BYTES) {
          flujo.pause();
          reject(new LimiteAdjunto("La hoja de Excel es demasiado grande para analizarla."));
          return;
        }
        trozos.push(trozo);
      })
      .on("error", (e: Error) => reject(e))
      .on("end", () => resolve(new TextDecoder("utf-8").decode(Buffer.concat(trozos))))
      .resume();
  });
}

async function leerXml(zip: JSZip, ruta: string): Promise<string | null> {
  const f = zip.file(ruta);
  return f ? leerAcotado(f) : null;
}

export async function parsearXlsx(bytes: Uint8Array): Promise<string[][]> {
  const zip = await JSZip.loadAsync(bytes);
  const libro = await leerXml(zip, "xl/workbook.xml");
  if (!libro) throw new LimiteAdjunto("El archivo no parece un libro de Excel (.xlsx).");
  const rels = (await leerXml(zip, "xl/_rels/workbook.xml.rels")) ?? "";
  // Primera hoja del libro: su r:id apunta, en las relaciones, al archivo real.
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(libro)?.[1];
  let ruta = "xl/worksheets/sheet1.xml";
  if (rid) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      if (new RegExp(`\\bId="${rid}"`).test(tag)) {
        const destino = /\bTarget="([^"]+)"/.exec(tag)?.[1];
        if (destino) ruta = destino.startsWith("/") ? destino.slice(1) : `xl/${destino}`;
      }
    }
  }
  const compartidas: string[] = [];
  const sst = await leerXml(zip, "xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) compartidas.push(textoDeSi(m[1] ?? ""));
  const hoja = await leerXml(zip, ruta);
  if (!hoja) throw new LimiteAdjunto("No encontré la primera hoja del libro.");

  const filas: string[][] = [];
  for (const fm of hoja.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const fila: string[] = [];
    for (const cm of (fm[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] ?? "";
      const cuerpo = cm[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const idx = ref ? columnaDe(ref) : fila.length;
      if (idx >= ADJUNTO_MAX_COLUMNAS) throw new LimiteAdjunto(`El archivo tiene más de ${ADJUNTO_MAX_COLUMNAS} columnas.`);
      const tipo = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1];
      let valor = "";
      if (tipo === "s") valor = v === undefined ? "" : (compartidas[Number(v)] ?? "");
      else if (tipo === "inlineStr") valor = textoDeSi(cuerpo);
      else if (tipo === "b") valor = v === "1" ? "verdadero" : "falso";
      else if (tipo === "e") valor = "";
      else valor = v === undefined ? "" : decodificarXml(v);
      while (fila.length < idx) fila.push("");
      fila[idx] = valor;
    }
    if (fila.some((c) => c.trim() !== "")) filas.push(fila);
    if (filas.length > ADJUNTO_MAX_FILAS + 1) throw new LimiteAdjunto(`El archivo tiene más de ${miles(ADJUNTO_MAX_FILAS)} filas.`);
  }
  return filas;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Perfil de columnas
// ---------------------------------------------------------------------------------------------------------------------------

const ENCABEZADO_PERSONAL_RE = /(nombre|name|apellido|tel[eé]fono|telefono|phone|celular|whatsapp|m[oó]vil|correo|mail|email|direcci[oó]n|direccion|domicilio|address|rfc|curp|cliente|customer|hu[eé]sped|huesped|guest|paciente|contacto|clabe|tarjeta|card|nss|\bine\b|pasaporte)/i;
const CORREO_RE = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
const TELEFONO_RE = /(?:\+?\d[\s().-]*){10,}/;
/** Fechas y fechas con hora (ISO o dd/mm/aaaa): tienen muchos digitos pero no son telefonos. */
const FECHA_RE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/;

/** Numero con formato de captura comun ("1,234.50", "$1 234", "1.234,56", "12%"); null si no es un numero. */
export function numeroDe(crudo: string): number | null {
  let s = crudo.trim().replace(/^\$\s*/, "").replace(/\s*%$/, "");
  if (s === "" || /[a-z]/i.test(s)) return null;
  s = s.replace(/\s/g, "");
  if (/^[-+]?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^[-+]?\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

interface Perfil {
  readonly nombre: string;
  readonly tipo: "numérica" | "texto" | "personal" | "vacía";
  readonly conDato: number;
  readonly distintos: number | null;
  readonly suma: number | null;
  readonly promedio: number | null;
  readonly minimo: number | null;
  readonly maximo: number | null;
}

function nombreColumna(crudo: string | undefined, i: number, usados: Set<string>): string {
  const base = (crudo ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || `Columna ${i + 1}`;
  let nombre = base;
  for (let k = 2; usados.has(nombre); k++) nombre = `${base} (${k})`;
  usados.add(nombre);
  // El encabezado es texto del archivo: datos de contacto que hubiera en el, redactados.
  return redactPii(nombre);
}

export function perfilarTabla(filas: readonly (readonly string[])[]): { readonly perfiles: Perfil[]; readonly registros: number } {
  const [encabezado = [], ...datos] = filas;
  const ancho = Math.max(encabezado.length, ...datos.map((f) => f.length), 0);
  if (ancho > ADJUNTO_MAX_COLUMNAS) throw new LimiteAdjunto(`El archivo tiene más de ${ADJUNTO_MAX_COLUMNAS} columnas.`);
  const usados = new Set<string>();
  const perfiles: Perfil[] = [];
  for (let c = 0; c < ancho; c++) {
    const crudoEncabezado = encabezado[c];
    const nombre = nombreColumna(crudoEncabezado, c, usados);
    const valores: string[] = [];
    for (const f of datos) {
      const v = (f[c] ?? "").trim();
      if (v !== "") valores.push(v);
    }
    if (valores.length === 0) {
      perfiles.push({ nombre, tipo: "vacía", conDato: 0, distintos: null, suma: null, promedio: null, minimo: null, maximo: null });
      continue;
    }
    const personal = ENCABEZADO_PERSONAL_RE.test(crudoEncabezado ?? "") || valores.some((v) => CORREO_RE.test(v) || (TELEFONO_RE.test(v) && v.replace(/\D/g, "").length >= 10 && !/^-?[\d,.]+$/.test(v) && !FECHA_RE.test(v)));
    if (personal) {
      perfiles.push({ nombre, tipo: "personal", conDato: valores.length, distintos: null, suma: null, promedio: null, minimo: null, maximo: null });
      continue;
    }
    const numeros = valores.map(numeroDe);
    const validos = numeros.filter((n): n is number => n !== null);
    if (validos.length >= Math.ceil(valores.length * 0.9)) {
      const suma = validos.reduce((a, b) => a + b, 0);
      perfiles.push({
        nombre,
        tipo: "numérica",
        conDato: valores.length,
        distintos: new Set(validos).size,
        suma: redondear(suma),
        promedio: redondear(suma / validos.length),
        minimo: Math.min(...validos),
        maximo: Math.max(...validos),
      });
    } else perfiles.push({ nombre, tipo: "texto", conDato: valores.length, distintos: new Set(valores).size, suma: null, promedio: null, minimo: null, maximo: null });
  }
  return { perfiles, registros: datos.length };
}

function respuestaDeTabla(nombre: string, tipo: "csv" | "xlsx", filas: readonly (readonly string[])[]): ResultadoAdjunto {
  if (filas.length < 2) return { ok: false, status: "invalid_input", motivo: "El archivo no tiene filas de datos debajo del encabezado." };
  let perfilado: ReturnType<typeof perfilarTabla>;
  try {
    perfilado = perfilarTabla(filas);
  } catch (e) {
    if (e instanceof LimiteAdjunto) return { ok: false, status: "invalid_input", motivo: e.message };
    throw e;
  }
  const { perfiles, registros } = perfilado;
  const numericas = perfiles.filter((p) => p.tipo === "numérica").length;
  const personales = perfiles.filter((p) => p.tipo === "personal").length;
  const textos = perfiles.filter((p) => p.tipo === "texto").length;
  const vacias = perfiles.filter((p) => p.tipo === "vacía").length;
  const partes = [`${numericas} numérica${numericas === 1 ? "" : "s"}`, `${textos} de texto`];
  if (personales > 0) partes.push(`${personales} con datos personales (solo se cuenta cuántas celdas tienen dato)`);
  if (vacias > 0) partes.push(`${vacias} vacía${vacias === 1 ? "" : "s"}`);
  const rows = perfiles.map((p) => ({ columna: p.nombre, tipo: p.tipo, con_dato: p.conDato, distintos: p.distintos, suma: p.suma, promedio: p.promedio, minimo: p.minimo, maximo: p.maximo }));
  return {
    ok: true,
    tipo,
    filas: registros,
    respuesta: {
      status: "ok",
      text: `«${redactPii(nombre).slice(0, 80)}» tiene ${miles(registros)} fila${registros === 1 ? "" : "s"} de datos y ${perfiles.length} columna${perfiles.length === 1 ? "" : "s"} (${partes.join(", ")}). Abajo está el perfil de cada columna; las columnas con datos personales no se detallan.${tipo === "xlsx" ? " Excel: se lee la primera hoja y el último valor guardado de cada celda; las fechas aparecen como número de serie." : ""}`,
      blocks: [
        {
          kind: "table",
          tool: "archivo_adjunto",
          title: "Perfil del archivo",
          columns: [
            { key: "columna", label: "Columna", kind: "text" },
            { key: "tipo", label: "Tipo", kind: "text" },
            { key: "con_dato", label: "Con dato", kind: "integer" },
            { key: "distintos", label: "Distintos", kind: "integer" },
            { key: "suma", label: "Suma", kind: "decimal" },
            { key: "promedio", label: "Promedio", kind: "decimal" },
            { key: "minimo", label: "Mínimo", kind: "decimal" },
            { key: "maximo", label: "Máximo", kind: "decimal" },
          ],
          rows: rows.slice(0, MAX_FILAS_TABLA),
          truncated: rows.length > MAX_FILAS_TABLA,
        },
      ],
      sources: [{ tool: "archivo_adjunto", source: "Archivo adjunto analizado en el servidor del Copiloto (no se guarda)", scopeLabel: "Solo este archivo" }],
      toolsUsed: ["archivo_adjunto"],
    },
  };
}

async function respuestaDePdf(nombre: string, bytes: Uint8Array): Promise<ResultadoAdjunto> {
  const r = await extractDocumentText(Buffer.from(bytes), { mimeType: "application/pdf", filename: nombre });
  if (r.status === "requires_ocr") return { ok: false, status: "invalid_input", motivo: "Este PDF no tiene texto seleccionable (parece escaneado) y todavía no puedo leer imágenes. Súbelo con texto o expórtalo a CSV." };
  if (r.status === "failed" || !r.pages) return { ok: false, status: "invalid_input", motivo: r.limitExceeded ? "El PDF es demasiado grande para analizarlo." : "No pude leer ese PDF (¿está dañado o protegido con contraseña?)." };
  const paginas = r.pages.map((p) => ({ pagina: p.page, caracteres: p.text.length, palabras: p.text.split(/\s+/).filter(Boolean).length }));
  const caracteres = paginas.reduce((a, p) => a + p.caracteres, 0);
  const palabras = paginas.reduce((a, p) => a + p.palabras, 0);
  const extracto = redactPii((r.pages.find((p) => p.text.trim() !== "")?.text ?? "").replace(/\s+/g, " ").trim()).slice(0, EXTRACTO_PDF_CHARS);
  return {
    ok: true,
    tipo: "pdf",
    filas: paginas.length,
    respuesta: {
      status: "ok",
      text: `«${redactPii(nombre).slice(0, 80)}» tiene ${miles(paginas.length)} página${paginas.length === 1 ? "" : "s"}, ${miles(palabras)} palabras y ${miles(caracteres)} caracteres de texto.${extracto ? ` Empieza así (con teléfonos, correos y enlaces ocultos): ${extracto}${extracto.length >= EXTRACTO_PDF_CHARS ? "…" : ""}` : ""}`,
      blocks: [
        {
          kind: "table",
          tool: "archivo_adjunto",
          title: "Páginas del PDF",
          columns: [
            { key: "pagina", label: "Página", kind: "integer" },
            { key: "caracteres", label: "Caracteres", kind: "integer" },
            { key: "palabras", label: "Palabras", kind: "integer" },
          ],
          rows: paginas.slice(0, MAX_FILAS_TABLA),
          truncated: paginas.length > MAX_FILAS_TABLA,
        },
      ],
      sources: [{ tool: "archivo_adjunto", source: "PDF adjunto leído en el servidor del Copiloto (no se guarda)", scopeLabel: "Solo este archivo" }],
      toolsUsed: ["archivo_adjunto"],
    },
  };
}

/** Punto de entrada: decide el tipo por el contenido y la extension, valida el tamano y devuelve el analisis (o el motivo honesto). Nunca lanza por contenido malo. */
export async function analizarAdjunto(nombre: string, bytes: Uint8Array): Promise<ResultadoAdjunto> {
  if (bytes.byteLength === 0) return { ok: false, status: "invalid_input", motivo: "El archivo está vacío." };
  if (bytes.byteLength > ADJUNTO_MAX_BYTES) return { ok: false, status: "invalid_input", motivo: "El archivo supera los 5 MB." };
  const tipo = tipoDeAdjunto(nombre, bytes);
  if (!tipo) return { ok: false, status: "invalid_input", motivo: "Solo puedo leer archivos CSV, Excel (.xlsx) y PDF." };
  try {
    if (tipo === "pdf") return await respuestaDePdf(nombre, bytes);
    if (tipo === "xlsx") return respuestaDeTabla(nombre, "xlsx", await parsearXlsx(bytes));
    return respuestaDeTabla(nombre, "csv", parsearCsv(new TextDecoder("utf-8").decode(bytes)));
  } catch (e) {
    if (e instanceof LimiteAdjunto) return { ok: false, status: "invalid_input", motivo: e.message };
    return { ok: false, status: "invalid_input", motivo: tipo === "xlsx" ? "No pude abrir ese Excel (¿está dañado o protegido con contraseña?)." : "No pude leer ese archivo." };
  }
}
