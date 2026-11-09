// Metricas de transcripcion: WER, errores en numeros, terminos del menu y direcciones entre el texto ORIGINAL del cliente y lo que el STT real entrego al agente.
// Puro (sin red). Los dos textos pasan por el MISMO normalizador: minusculas, sin tildes ni signos, "$1,200" -> "1200", "12:30" -> "12 30" y numeros en letra -> cifras
// ("trescientos cuarenta y cinco" == "345"), porque Deepgram con formato inteligente escribe cifras y el guion del cliente va en letra.
import { partirCifras } from "../voz-medicion-real/ruido-stt.ts";

const NUM = new Set([
  "cero", "un", "uno", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho",
  "diecinueve", "veinte", "veintiuno", "veintiun", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve", "treinta", "cuarenta",
  "cincuenta", "sesenta", "setenta", "ochenta", "noventa", "cien", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos", "mil",
]);

export function normalizar(texto: string): string[] {
  const t = texto
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/(\d)[.,](?=\d{3}\b)/g, "$1")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter(Boolean);
  const salida: string[] = [];
  for (let i = 0; i < t.length;) {
    if (NUM.has(t[i]!)) {
      const corrida: string[] = [t[i]!];
      let j = i + 1;
      while (j < t.length && (NUM.has(t[j]!) || (t[j] === "y" && j + 1 < t.length && NUM.has(t[j + 1]!)))) { corrida.push(t[j]!); j += 1; }
      for (const n of partirCifras(corrida)) salida.push(String(n));
      i = j;
    } else { salida.push(t[i]!); i += 1; }
  }
  return salida;
}

export interface ResultadoWer { readonly sustituciones: number; readonly borrados: number; readonly insertados: number; readonly n: number; readonly wer: number | null }

/** WER por distancia de edicion de palabras con desglose S/D/I. `n` = palabras de la referencia; wer null si la referencia esta vacia. */
export function wer(ref: readonly string[], hip: readonly string[]): ResultadoWer {
  const n = ref.length; const m = hip.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => { const f = new Array<number>(m + 1).fill(0); f[0] = i; return f; });
  for (let j = 0; j <= m; j += 1) d[0]![j] = j;
  for (let i = 1; i <= n; i += 1) for (let j = 1; j <= m; j += 1) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (ref[i - 1] === hip[j - 1] ? 0 : 1));
  let i = n; let j = m; let s = 0; let b = 0; let ins = 0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (ref[i - 1] === hip[j - 1] ? 0 : 1)) { if (ref[i - 1] !== hip[j - 1]) s += 1; i -= 1; j -= 1; }
    else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) { b += 1; i -= 1; }
    else { ins += 1; j -= 1; }
  }
  return { sustituciones: s, borrados: b, insertados: ins, n, wer: n === 0 ? null : (s + b + ins) / n };
}

export interface ConteoErrores { readonly n: number; readonly errores: number; readonly faltantes: readonly string[] }

/** Cifras de la referencia (tokens numericos tras normalizar) que no aparecen en la hipotesis (multiconjunto: un "2" dicho dos veces y oido una, es un error). */
export function erroresNumeros(ref: readonly string[], hip: readonly string[]): ConteoErrores {
  const pool = new Map<string, number>();
  for (const h of hip) pool.set(h, (pool.get(h) ?? 0) + 1);
  const faltantes: string[] = [];
  let n = 0;
  for (const r of ref) {
    if (!/^\d+$/.test(r)) continue;
    n += 1;
    const c = pool.get(r) ?? 0;
    if (c > 0) pool.set(r, c - 1); else faltantes.push(r);
  }
  return { n, errores: faltantes.length, faltantes };
}

const VACIAS = new Set(["tacos", "taco", "con", "sin", "de", "del", "la", "las", "los", "el", "una", "para", "orden", "ordenes", "extra"]);

/** Terminos del menu (nombres completos y sus palabras significativas, >= 4 letras) que el cliente dijo y que el STT no entrego. */
export function erroresTerminos(refTexto: string, hipTexto: string, vocabulario: readonly string[]): ConteoErrores {
  const ref = ` ${normalizar(refTexto).join(" ")} `; const hip = ` ${normalizar(hipTexto).join(" ")} `;
  const terminos = new Set<string>();
  for (const v of vocabulario) {
    const nv = normalizar(v);
    if (nv.length) terminos.add(nv.join(" "));
    for (const w of nv) if (w.length >= 4 && !VACIAS.has(w) && !/^\d+$/.test(w)) terminos.add(w);
  }
  const faltantes: string[] = [];
  let n = 0;
  for (const t of terminos) {
    if (!ref.includes(` ${t} `)) continue;
    n += 1;
    if (!hip.includes(` ${t} `)) faltantes.push(t);
  }
  return { n, errores: faltantes.length, faltantes };
}

/** Heuristica: el turno dicta una direccion (calle, numero, colonia, cruzamientos). */
export function esDireccion(refTexto: string): boolean {
  return /\b(calle|avenida|av|colonia|fraccionamiento|numero|casa|departamento|depto|manzana|lote|cruzamiento|entre|esquina)\b/.test(normalizar(refTexto).join(" "));
}
