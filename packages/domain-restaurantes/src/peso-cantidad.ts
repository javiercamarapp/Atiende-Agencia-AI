// Parser de cantidades de peso de una consulta de productos ("cuarto kilo", "2 kg y medio", "0,25 kg", "tres cuartos", "250 gramos"...).
// Gramatica explicita y pequena en vez de un monton de regex; convierte cada frase de peso en gramos EXACTOS, o la deja como estaba (nunca adivina).
//
//   frase    := valor [ "de" ] unidad [ "y" fraccion ] [ "y" valor_g unidad_g ]     (kilo y medio: unidad primero)
//             | unidad_kg [ "y" fraccion ]                                           ("kilo", "kilo y cuarto")
//             | valor_sin_unidad                                                     (solo "cuarto(s)" y "medio de": "un cuarto de bistec")
//   valor    := numero [ "y" fraccion | fraccion_con_barra | palabra_fraccion ] | fraccion
//   numero   := digitos con punto o coma decimal | un uno una dos ... veinte treinta cuarenta cincuenta
//   fraccion := 1/2 1/4 3/4 (y ½ ¼ ¾, que llegan ya como 1/2 1/4 3/4) | medio media | cuarto
//   palabra_fraccion := medio(s) | cuarto(s)   ("un medio" = 1 x 1/2; "tres cuartos" = 3 x 1/4; "cuatro cuartos" = 4 x 1/4)
//   unidad   := kg kilo kilos kilogramo(s) (k pegada a un numero) | g gr grs gramo(s)
//
// Entrada: texto ya en minusculas y sin acentos. Salida: el mismo texto con cada frase de peso reemplazada por ` peso:<gramos> `.

const NUMEROS: Readonly<Record<string, number>> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
};
const FRACCION_BARRA: Readonly<Record<string, number>> = { "1/2": 0.5, "1/4": 0.25, "3/4": 0.75 };
const UNIDAD_KG = /^(?:kg|kgs|kgr|kgrs|kilo|kilos|kilogramo|kilogramos)$/;
const UNIDAD_G = /^(?:g|gr|grs|gramo|gramos)$/;
const DECIMAL = /^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/;

/** Cuanto "pesa" el valor y si por si solo (sin unidad) ya es un peso. */
interface Valor {
  readonly v: number;
  readonly next: number;
  /** "siempre": cuartos y 1/4, 3/4 (un cuarto de bistec); "con_de": "medio de pastor"; "nunca": numeros, 1/2 ("media orden"), "dos medios". */
  readonly sinUnidad: "siempre" | "con_de" | "nunca";
  readonly entero: boolean;
}

function aNumero(w: string | undefined): number | null {
  if (w === undefined) return null;
  if (DECIMAL.test(w)) return Number(w.replace(",", "."));
  return NUMEROS[w] ?? null;
}
const esFraccionPalabra = (w: string | undefined) => w === "medio" || w === "media" || w === "cuarto";
const valorFraccion = (w: string): number => (w === "cuarto" ? 0.25 : 0.5);

/** "y medio" / "y cuarto" / "y 1/2" a partir de `i` (w[i] === "y"). */
function yFraccion(w: readonly string[], i: number): { v: number; next: number } | null {
  if (w[i] !== "y" && w[i] !== "con") return null;
  const f = w[i + 1];
  if (f === undefined) return null;
  if (esFraccionPalabra(f)) return { v: valorFraccion(f), next: i + 2 };
  if (FRACCION_BARRA[f] !== undefined) return { v: FRACCION_BARRA[f]!, next: i + 2 };
  return null;
}

function parseValor(w: readonly string[], i: number): Valor | null {
  const t = w[i];
  if (t === undefined) return null;
  // Fraccion sola: "1/4", "medio", "cuarto", "media".
  if (FRACCION_BARRA[t] !== undefined) {
    const f = FRACCION_BARRA[t]!;
    return { v: f, next: i + 1, sinUnidad: t === "1/2" ? "nunca" : "siempre", entero: false };
  }
  if (esFraccionPalabra(t)) {
    const extra = yFraccion(w, i + 1);
    return { v: valorFraccion(t) + (extra?.v ?? 0), next: extra?.next ?? i + 1, sinUnidad: t === "cuarto" && !extra ? "con_de" : t === "medio" && !extra ? "con_de" : "nunca", entero: false };
  }
  const n = aNumero(t);
  if (n === null) return null;
  const articulo = t === "un" || t === "uno" || t === "una";
  const sig = w[i + 1];
  // "N y medio", "N y cuarto", "N y 1/2".
  const suma = yFraccion(w, i + 1);
  if (suma) return { v: n + suma.v, next: suma.next, sinUnidad: "nunca", entero: false };
  // "2 1/2" (suma) vs "un 1/2" (producto: un medio).
  if (sig !== undefined && FRACCION_BARRA[sig] !== undefined) {
    const f = FRACCION_BARRA[sig]!;
    return articulo ? { v: n * f, next: i + 2, sinUnidad: "nunca", entero: false } : { v: n + f, next: i + 2, sinUnidad: "nunca", entero: false };
  }
  // "un cuarto", "tres cuartos", "dos medios", "un medio".
  if (sig === "cuarto" || sig === "cuartos") return { v: n * 0.25, next: i + 2, sinUnidad: "siempre", entero: false };
  if (sig === "medio" || sig === "medios" || sig === "media" || sig === "medias") return { v: n * 0.5, next: i + 2, sinUnidad: "nunca", entero: false };
  return { v: n, next: i + 1, sinUnidad: "nunca", entero: Number.isInteger(n) };
}

interface Frase {
  readonly gramos: number;
  readonly next: number;
}

/** Continuaciones con unidad: "2 kilos y 500 gramos", "medio kilo y un cuarto", "kilo y medio"; suman a lo anterior. `kg` = la frase previa estaba en kilos
 * (solo entonces una fraccion suelta como "y medio" o "y 1/4" se lee en kilos). */
function continuaciones(w: readonly string[], i: number, kg: boolean): { g: number; next: number } {
  let g = 0;
  let j = i;
  while (w[j] === "y" || w[j] === "con") {
    const frase = parseFrase(w, j + 1);
    if (frase) {
      g += frase.gramos;
      j = frase.next;
      continue;
    }
    const val = kg ? parseValor(w, j + 1) : null;
    if (val && !val.entero && val.v < 1) {
      g += val.v * 1000;
      j = val.next;
      continue;
    }
    break;
  }
  return { g, next: j };
}

function parseFrase(w: readonly string[], i: number): Frase | null {
  // Unidad primero: "kilo", "kilos", "kilo y medio", "kg y cuarto".
  if (UNIDAD_KG.test(w[i] ?? "")) {
    const c = continuaciones(w, i + 1, true);
    return { gramos: 1000 + c.g, next: c.next };
  }
  const val = parseValor(w, i);
  if (!val) return null;
  // "cuarto DE kilo", "medio DE kilo".
  const kUnidad = !val.entero && w[val.next] === "de" ? val.next + 1 : val.next;
  const u = w[kUnidad] ?? "";
  if (UNIDAD_KG.test(u)) {
    const c = continuaciones(w, kUnidad + 1, true);
    return { gramos: val.v * 1000 + c.g, next: c.next };
  }
  if (UNIDAD_G.test(u) && val.v >= 10) {
    const c = continuaciones(w, kUnidad + 1, false);
    return { gramos: val.v + c.g, next: c.next };
  }
  // Sin unidad: solo cuartos ("un cuarto de bistec") y "medio de ...".
  if (val.sinUnidad === "siempre") return { gramos: val.v * 1000, next: val.next };
  if (val.sinUnidad === "con_de" && w[val.next] === "de") return { gramos: val.v * 1000, next: val.next };
  return null;
}

/** Prepara el texto: fracciones Unicode, numero pegado a la unidad ("250g", "1kg", "2k"), puntuacion. */
function preparar(texto: string): string[] {
  return texto
    .replace(/(\d)\s*½/g, "$1 y 1/2")
    .replace(/½/g, " 1/2 ")
    .replace(/¼/g, " 1/4 ")
    .replace(/¾/g, " 3/4 ")
    .replace(/(\d)\s*k\b/g, "$1 kg")
    .replace(/(\d)\s*(kgs|kgrs|kgr|kg|kilogramos?|kilos?|grs|gr|gramos?|g)\b/g, "$1 $2")
    .replace(/(\d\/\d)\s*(kg|kilo)/g, "$1 $2")
    .replace(/[,;](?!\d)/g, " ")
    .replace(/(?<!\d)[,;]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Reemplaza cada frase de peso por ` peso:<gramos> `; lo demas queda igual. */
export function normalizarPesos(textoSinAcentos: string): string {
  const w = preparar(textoSinAcentos);
  const salida: string[] = [];
  for (let i = 0; i < w.length; ) {
    const f = parseFrase(w, i);
    if (f && Number.isFinite(f.gramos) && f.gramos > 0 && f.gramos <= 100000) {
      salida.push(`peso:${Math.round(f.gramos)}`);
      i = f.next;
    } else {
      salida.push(w[i]!);
      i++;
    }
  }
  return salida.join(" ");
}
