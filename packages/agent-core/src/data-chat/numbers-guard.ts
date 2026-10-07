// "Nunca inventa cifras": todo número que aparezca en el texto narrado por el modelo
// debe existir en los resultados de las herramientas (o en la pregunta/periodo). Si no,
// el motor DESCARTA la narrativa y muestra el resumen determinista + las tablas.
//
// Defensa en profundidad (QA R1, agentes-15..18). La guardia NO confía en:
//  - cifras escritas con letras ("noventa y nueve mil"): se convierten a número y se validan igual;
//  - cifras con multiplicador ("99 mil", "1.5 millones", "99k"): se escalan antes de validar;
//  - los números de la PREGUNTA como dato: un usuario (o un texto pegado) puede sugerir "$99,000" y el modelo
//    "confirmarlo". De la pregunta solo valen números estructurales (top N, últimos N días, una fecha);
//  - los números de celdas de TEXTO (notas, nombres capturados por clientes o empleados): solo valen en celdas con
//    forma de fecha/hora; un texto libre puede citarse COMPLETO (nombre del producto) sin que sus números cuenten;
//  - tolerancias amplias: un entero cualquiera 0..#filas ya no valida un %, un monto ni un conteo grande, y un
//    decimal solo vale si coincide con un dato REDONDEADO a los mismos decimales que escribió el modelo.
import { formatCell } from "./format.js";
import type { DataChatToolResult } from "./types.js";

/** Posiciones/conteos que se aceptan sin estar en los datos ("top 3", "2 de 5"): 0..POSITION_CAP y el total de filas. */
const POSITION_CAP = 10;

// ---------------------------------------------------------------------------------------------------------------
// Normalizacion y cifras con letras
// ---------------------------------------------------------------------------------------------------------------

function normalizar(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const UNIDADES: Readonly<Record<string, number>> = { cero: 0, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };
const UNO = new Set(["un", "uno", "una"]);
const ESPECIALES: Readonly<Record<string, number>> = {
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const DECENAS: Readonly<Record<string, number>> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const CENTENAS: Readonly<Record<string, number>> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800,
  ochocientas: 800, novecientos: 900, novecientas: 900,
};

type Cat = "unidad" | "especial" | "decena" | "centena" | "mil" | "millon" | "uno";

function categoria(w: string): Cat | null {
  if (w in UNIDADES) return "unidad";
  if (w in ESPECIALES) return "especial";
  if (w in DECENAS) return "decena";
  if (w in CENTENAS) return "centena";
  if (w === "mil") return "mil";
  if (w === "millon" || w === "millones") return "millon";
  if (UNO.has(w)) return "uno";
  return null;
}

function valorBase(w: string, cat: Cat): number {
  if (cat === "unidad") return UNIDADES[w]!;
  if (cat === "especial") return ESPECIALES[w]!;
  if (cat === "decena") return DECENAS[w]!;
  if (cat === "centena") return CENTENAS[w]!;
  return 1;
}

const WORD = "(?:cero|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiun|veintiuno|veintiuna|veintidos|veintitres|veinticuatro|veinticinco|veintiseis|veintisiete|veintiocho|veintinueve|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|doscientas|trescientos|trescientas|cuatrocientos|cuatrocientas|quinientos|quinientas|seiscientos|seiscientas|setecientos|setecientas|ochocientos|ochocientas|novecientos|novecientas|mil|millon|millones)";
const WORD_RUN_RE = new RegExp(`\\b${WORD}(?:\\s+(?:y\\s+)?${WORD})*\\b`, "g");

/** Convierte una corrida de palabras-numero ya normalizada en uno o mas numeros (respetando la gramatica). */
function numerosDeCorrida(palabras: readonly string[]): number[] {
  const out: number[] = [];
  let total = 0;
  let cur = 0;
  let last: Cat | null = null;
  let abierto = false;
  const flush = () => {
    if (abierto) out.push(total + cur);
    total = 0;
    cur = 0;
    last = null;
    abierto = false;
  };
  for (const w of palabras) {
    if (w === "y") continue;
    const cat = categoria(w);
    if (cat === null) continue;
    const v = valorBase(w, cat);
    // Una transicion que la gramatica no permite ("dos tres") cierra el numero anterior y abre otro.
    const sigueDeMenor = last === "centena" || last === "decena" || last === "especial" || last === "unidad" || last === "uno";
    let continua = true;
    switch (cat) {
      case "centena":
        continua = last === null || last === "mil" || last === "millon";
        break;
      case "decena":
      case "especial":
        continua = last === null || last === "centena" || last === "mil" || last === "millon";
        break;
      case "unidad":
      case "uno":
        continua = last === null || last === "centena" || last === "decena" || last === "mil" || last === "millon";
        break;
      case "mil":
        continua = last === null || (sigueDeMenor && total % 1_000_000 === 0);
        break;
      case "millon":
        continua = last === null || sigueDeMenor;
        break;
    }
    if (!continua) flush();
    if (cat === "mil") {
      total += (cur === 0 ? 1 : cur) * 1000;
      cur = 0;
    } else if (cat === "millon") {
      total = (total + (cur === 0 ? 1 : cur)) * 1_000_000;
      cur = 0;
    } else {
      cur += v;
    }
    abierto = true;
    last = cat;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Extraccion de cifras
// ---------------------------------------------------------------------------------------------------------------

export interface NumberToken {
  readonly value: number;
  /** Decimales escritos (0 para enteros, cifras con letras o con multiplicador). */
  readonly decimals: number;
  /** `plain` = entero sin $ ni % ni "pesos": el unico que puede ser una posicion/conteo. */
  readonly kind: "plain" | "money" | "percent";
  /** Texto normalizado inmediatamente antes y despues de la cifra (hasta 30 caracteres): lo usa la guardia para distinguir "top 3" de "2 inasistencias". */
  readonly before: string;
  readonly after: string;
}

const CONTEXTO = 30;
function contextoDe(texto: string, inicio: number, fin: number): { before: string; after: string } {
  return { before: texto.slice(Math.max(0, inicio - CONTEXTO), inicio), after: texto.slice(fin, fin + CONTEXTO) };
}

const SCALE: Readonly<Record<string, number>> = { k: 1e3, mil: 1e3, millon: 1e6, millones: 1e6 };
const DIGITS_RE = /(\$\s*)?(\d[\d,]*(?:\.\d+)?)(?:\s*(millones|millon|mil|k)\b)?(\s*%|\s*(?:pesos|mxn)\b)?/g;

/** Tokens numericos del texto: digitos (con separador de miles, multiplicador, $ y %) y cifras escritas con letras. */
export function extractNumberTokens(text: string): NumberToken[] {
  // "12 por ciento" es un porcentaje, no el numero 100 ("ciento"): se lee como "12%".
  const norm = normalizar(text).replace(/\s+por\s+ciento\b/g, "%");
  const out: NumberToken[] = [];
  for (const m of norm.matchAll(DIGITS_RE)) {
    const raw = m[2]!;
    const base = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const scale = m[3] ? SCALE[m[3]]! : 1;
    const tail = m[4] ?? "";
    const kind: NumberToken["kind"] = tail.includes("%") ? "percent" : m[1] || tail.length > 0 || scale > 1 ? "money" : "plain";
    const dot = raw.indexOf(".");
    const inicio = m.index ?? 0;
    out.push({ value: base * scale, decimals: scale > 1 ? 0 : dot < 0 ? 0 : raw.length - dot - 1, kind: scale > 1 && kind === "plain" ? "money" : kind, ...contextoDe(norm, inicio + (m[1]?.length ?? 0), inicio + m[0].length) });
  }
  // Cifras con letras: se ignoran las corridas que son solo "un/uno/una" (articulo, no cifra).
  const sinDigitos = norm.replace(DIGITS_RE, " ");
  for (const m of sinDigitos.matchAll(WORD_RUN_RE)) {
    const palabras = m[0].split(/\s+/);
    if (palabras.every((w) => UNO.has(w))) continue;
    // Mismo contexto que los digitos: "$" antes, o "pesos"/"mxn"/"%" despues, vuelven la cifra monto o porcentaje.
    const antes = sinDigitos.slice(0, m.index).trimEnd();
    const despues = sinDigitos.slice((m.index ?? 0) + m[0].length);
    const kind: NumberToken["kind"] = /^\s*%/.test(despues) ? "percent" : antes.endsWith("$") || /^\s*(?:pesos|mxn)\b/.test(despues) ? "money" : "plain";
    const ctx = contextoDe(sinDigitos, m.index ?? 0, (m.index ?? 0) + m[0].length);
    for (const n of numerosDeCorrida(palabras)) out.push({ value: n, decimals: 0, kind, ...ctx });
  }
  return out;
}

export function extractNumbers(text: string): number[] {
  return extractNumberTokens(text).map((t) => t.value);
}

// ---------------------------------------------------------------------------------------------------------------
// Numeros permitidos
// ---------------------------------------------------------------------------------------------------------------

/** Conjunto de valores de DATOS (celdas numericas, fuente, periodo, alcance, resumen) mas lo estructural. */
export class AllowedNumbers extends Set<number> {
  /** Posiciones pequenas (0..10, acotadas por el numero de filas): solo para cifras `plain` en contexto de posicion ("top 3", "2 de 5", "el primer lugar"). */
  readonly positions = new Set<number>();
  /** Numero de filas de cada resultado: vale en contexto de posicion o seguido de lo que cuenta la tabla ("7 dias", "2 profesionales"), NUNCA como conteo de una medida ("2 inasistencias"). */
  readonly rowCounts = new Set<number>();
  /** Numeros de ETIQUETAS (fecha/hora de una celda, periodo, fuente, alcance): solo valen como cifra `plain` (un dia, un año, "7 días"), nunca como % ni monto. */
  readonly labels = new Set<number>();
  /** Numeros estructurales de la pregunta (top N, ultimos N dias, fechas): coincidencia exacta, solo `plain`. */
  readonly structural = new Set<number>();
  /** Textos libres de celdas (normalizados): si el modelo los cita COMPLETOS, sus numeros no cuentan como cifras. */
  readonly verbatim: string[] = [];
}

const MESES = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sep|sept|oct|nov|dic";
const QUESTION_STRUCTURAL: readonly RegExp[] = [
  /\b(?:top|primeros?|primeras?|ultimos?|ultimas?|mejores|peores|principales)\s+(\d{1,3})\b/g,
  /\b(\d{1,3})\s+(?:dias?|semanas?|mes(?:es)?|anos?|horas?)\b/g,
  new RegExp(`\\b(\\d{1,2})\\s+(?:de\\s+)?(?:${MESES})\\b`, "g"),
  new RegExp(`\\b(?:${MESES})\\s+(?:de\\s+)?(\\d{1,2})\\b`, "g"),
  // Sin regla de "años" sueltos: un monto de 1900 a 2099 ("$2000") se confundiria con un año. El año del periodo ya llega como etiqueta.
];

function numerosEstructuralesDePregunta(question: string): number[] {
  const norm = normalizar(question);
  const out: number[] = [];
  for (const re of QUESTION_STRUCTURAL) {
    for (const m of norm.matchAll(re)) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

/** Celdas de texto con forma de fecha/hora (etiquetas de periodo): sus numeros si valen. */
const FECHA_HORA_RE = /^\s*\d{4}-\d{2}(?:-\d{2})?(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\s*$|^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/;

function normalizarCelda(s: string): string {
  return normalizar(s).replace(/\s+/g, " ").trim();
}

export function allowedNumbers(question: string, results: readonly DataChatToolResult[]): AllowedNumbers {
  const allowed = new AllowedNumbers();
  const add = (n: number) => {
    allowed.add(n);
    allowed.add(Math.abs(n));
  };
  numerosEstructuralesDePregunta(question).forEach((n) => allowed.structural.add(n));
  for (const r of results) {
    // Etiquetas que arma el CODIGO de la herramienta (fuente, periodo, alcance, resumen): confiables.
    [r.source, r.periodLabel ?? "", r.scopeLabel].forEach((t) => extractNumbers(t).forEach((n) => allowed.labels.add(n)));
    extractNumbers(r.summary ?? "").forEach(add);
    // posiciones/conteos ("top 3", "2 de 5"): 0..10 y el total de filas, nada mas.
    for (let i = 0; i <= Math.min(r.rows.length, POSITION_CAP); i += 1) allowed.positions.add(i);
    allowed.rowCounts.add(r.rows.length);
    for (const row of r.rows) {
      for (const col of r.columns) {
        const v = row[col.key];
        if (v === null || v === undefined) continue;
        if (typeof v === "number") {
          add(v);
          // El valor tal cual lo ve el usuario ya formateado (p.ej. "$1,500.50 MXN"): mismo numero, otra escritura.
          extractNumbers(formatCell(col.kind, v)).forEach(add);
        } else if (FECHA_HORA_RE.test(v)) {
          extractNumbers(v).forEach((n) => allowed.labels.add(n));
        } else if (/\p{L}/u.test(v)) {
          // Texto libre (puede traer notas o nombres escritos por terceros): sus numeros NO son datos.
          const n = normalizarCelda(v);
          if (n.length >= 3) allowed.verbatim.push(n);
        }
      }
    }
  }
  allowed.verbatim.sort((a, b) => b.length - a.length);
  return allowed;
}

function redondea(v: number, decimals: number): number {
  return Number(Math.abs(v).toFixed(decimals));
}

/** "top 3", "los primeros 3", "2 de 5", "el 1o lugar", "3 mejores": la cifra es una posicion u orden, no una medida. */
const POSICION_ANTES_RE = /(?:^|[\s(])(?:top|primer[oa]?s?|ultim[oa]s?|mejor(?:es)?|peor(?:es)?|principal(?:es)?|numero|lugar|puesto|posicion|fila|filas|tabla|tablas|renglon|columna|linea|paso|punto|seccion|grafica|item)\s*$|#\s*$|\d\s+de\s*$/;
/** Numeracion de una lista ("1. Ana", "2) Beto") al inicio de linea. */
const MARCADOR_DE_LISTA_RE = /^\s*[.)]\s/;
const POSICION_DESPUES_RE = /^\s*(?:de\s+\d|[ºo°]\b|lugar\b|puesto\b|mejor|peor|primer|ultim|principal)/;
function enContextoDePosicion(t: NumberToken): boolean {
  return POSICION_ANTES_RE.test(t.before) || POSICION_DESPUES_RE.test(t.after) || (/(?:^|\n)\s*$/.test(t.before) && MARCADOR_DE_LISTA_RE.test(t.after));
}
/** Lo que cuentan las filas de una tabla: "7 dias", "2 profesionales", "3 filas". */
const FILA_DESPUES_RE = /^\s*(?:dias?|semanas?|meses|mes|horas?|filas?|renglones|registros?|profesionales?|proveedores?|servicios?|clientes?|pacientes?|sucursales|sucursal|productos?|categorias?|canales|canal|empleados?|turnos?)\b/;

function respaldado(t: NumberToken, allowed: ReadonlySet<number>): boolean {
  const rich = allowed instanceof AllowedNumbers ? allowed : null;
  if (rich && t.kind === "plain" && t.decimals === 0) {
    if (rich.structural.has(t.value) || rich.labels.has(t.value)) return true;
    // Un entero chico solo se acepta como POSICION o como conteo de filas; antes cualquier entero 0..#filas pasaba siempre y un conteo mal atribuido
    // ("Beto Ruiz tuvo 2 inasistencias", dato real 0) llegaba al dueño.
    if (rich.positions.has(t.value) && enContextoDePosicion(t)) return true;
    if (rich.rowCounts.has(t.value) && (enContextoDePosicion(t) || FILA_DESPUES_RE.test(t.after))) return true;
  }
  const target = Math.abs(t.value);
  for (const v of allowed) {
    if (!Number.isFinite(v)) continue;
    // Coincide con un dato REDONDEADO a los mismos decimales que escribio el modelo (nunca a una cifra mas gruesa).
    if (redondea(v, t.decimals) === target) return true;
  }
  return false;
}

/** Números del texto que NO están respaldados por los resultados. Vacío = texto limpio. */
export function unsupportedNumbers(text: string, allowed: ReadonlySet<number>): number[] {
  let limpio = normalizar(text);
  if (allowed instanceof AllowedNumbers) {
    // Un texto libre de una celda citado completo (nombre de producto) no aporta cifras.
    for (const cell of allowed.verbatim) limpio = limpio.split(cell).join(" ");
  }
  return extractNumberTokens(limpio)
    .filter((t) => !respaldado(t, allowed))
    .map((t) => t.value);
}
