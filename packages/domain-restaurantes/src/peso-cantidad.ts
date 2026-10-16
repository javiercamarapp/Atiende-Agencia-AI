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
// Variantes coloquiales (L2b, 14-oct): diminutivos (kilito, cuartito), "mitad" = medio, numeros escritos con letra de tres cifras y "mil"
// ("doscientos cincuenta", "mil doscientos cincuenta"), sumas SIN "y" despues de una unidad en kilos ("kilo 250", "1 kg 250 g", "kilo cuarto", "kilo 3/4"),
// "mas"/"menos" ("kilo mas medio", "kilo menos cuarto" = 750 g), "un par de kilos" = 2 kg, "1,250 g", "kg." con punto, signos de interrogacion/exclamacion.
// Lo APROXIMADO ("casi un kilo", "kilo y pico", "kilo y poquito", "mas o menos 2 kilos") NO es un peso exacto: salen como
// `peso:cualquiera` (lista todas las presentaciones, marcado ambiguo, para que el agente pregunte). Un numero SIN unidad ("750 de pastor", "setecientos cincuenta de pastor")
// no es peso (puede ser dinero o piezas).
//
// Entrada: texto ya en minusculas y sin acentos. Salida: el mismo texto con cada frase de peso reemplazada por ` peso:<gramos> `.

const NUMEROS: Readonly<Record<string, number>> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
};
const FRACCION_BARRA: Readonly<Record<string, number>> = { "1/2": 0.5, "1/4": 0.25, "3/4": 0.75 };
const UNIDAD_KG = /^(?:kg|kgs|kgr|kgrs|kilo|kilos|kilogramo|kilogramos)$/;
/** Lo que sigue a "kilo 250" cuando NO son gramos sino dinero o piezas ("un kilo 250 pesos", "kilo 100 tacos"): solo "de" o el final de la frase confirman gramos. */
const SEGUIDO_DE_GRAMOS_SUELTOS = (w: string | undefined) => w === undefined || w === "de";
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

const esGramosSueltos = (v: number) => Number.isInteger(v) && v >= 50 && v <= 950 && v % 50 === 0;

/** Continuaciones con unidad: "2 kilos y 500 gramos", "medio kilo y un cuarto", "kilo y medio"; suman a lo anterior. `kg` = la frase previa estaba en kilos
 * (solo entonces una fraccion suelta como "y medio" o "y 1/4" se lee en kilos, y un "250" suelto son gramos). Conectores: "y", "con", "mas" (suman) y "menos" (resta).
 * Despues de kilos tambien suman SIN conector: "kilo 250", "1 kg 250 g", "kilo 3/4", "kilo cuarto". */
function continuaciones(w: readonly string[], i: number, kg: boolean): { g: number; next: number } {
  let g = 0;
  let j = i;
  for (;;) {
    const conector = w[j] === "y" || w[j] === "con" || w[j] === "mas";
    const resta = w[j] === "menos";
    const k = conector || resta ? j + 1 : j;
    const signo = resta ? -1 : 1;
    const frase = parseFrase(w, k);
    // Sin conector solo con la forma que no se confunde con otra cosa: numero + gramos explicitos ("1 kg 250 g").
    const explicita = frase !== null && (conector || resta || (kg && UNIDAD_G.test(w[(w[k + 1] === "de" ? k + 2 : k + 1)] ?? "") && aNumero(w[k]) !== null));
    if (frase && explicita) {
      g += signo * frase.gramos;
      j = frase.next;
      continue;
    }
    if (!kg) break;
    const val = parseValor(w, k);
    if (val && !val.entero && val.v < 1 && (conector || resta || w[k] === "cuarto" || w[k] === "medio" || w[k] === "media" || FRACCION_BARRA[w[k] ?? ""] !== undefined)) {
      g += signo * val.v * 1000;
      j = val.next;
      continue;
    }
    // "kilo y 250", "kilo 500 de pastor": gramos sueltos (nunca con "pesos"/"tacos" detras: eso es dinero o piezas).
    const suelto = aNumero(w[k]);
    if (suelto !== null && DECIMAL.test(w[k]!) && esGramosSueltos(suelto) && SEGUIDO_DE_GRAMOS_SUELTOS(w[k + 1])) {
      g += signo * suelto;
      j = k + 1;
      continue;
    }
    break;
  }
  return { g, next: j };
}

/** "cuarto DE hora" / "un cuarto de dia": no es peso. */
const esDeTiempo = (w: readonly string[], i: number) => w[i] === "de" && /^(?:hora|horas|dia|dias|siglo|final)$/.test(w[i + 1] ?? "");

function parseFrase(w: readonly string[], i: number): Frase | null {
  // "un par de kilos" = 2 kg.
  const par = w[i] === "par" ? i : w[i] === "un" && w[i + 1] === "par" ? i + 1 : -1;
  if (par >= 0 && w[par + 1] === "de" && UNIDAD_KG.test(w[par + 2] ?? "")) {
    const c = continuaciones(w, par + 3, true);
    return { gramos: 2000 + c.g, next: c.next };
  }
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
  if (esDeTiempo(w, val.next)) return null;
  if (val.sinUnidad === "siempre") return { gramos: val.v * 1000, next: val.next };
  if (val.sinUnidad === "con_de" && w[val.next] === "de") return { gramos: val.v * 1000, next: val.next };
  return null;
}

const CIENTOS: Readonly<Record<string, number>> = { cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900 };
const DECENAS: Readonly<Record<string, number>> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const VEINTI: Readonly<Record<string, number>> = { veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29 };
const UNIDADES: Readonly<Record<string, number>> = { uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9 };

/** Numero en letra a partir de `i` ("mil doscientos cincuenta", "setecientos cincuenta", "treinta y cinco", "dos mil"); null si no empieza uno. Hasta 9999. */
function numeroEnLetra(w: readonly string[], i: number): { n: number; next: number } | null {
  let j = i;
  let total = 0;
  const bajo = (k: number): { v: number; next: number } | null => {
    const t = w[k] ?? "";
    if (DECENAS[t] !== undefined) {
      const u = UNIDADES[w[k + 2] ?? ""];
      return w[k + 1] === "y" && u !== undefined ? { v: DECENAS[t]! + u, next: k + 3 } : { v: DECENAS[t]!, next: k + 1 };
    }
    if (VEINTI[t] !== undefined) return { v: VEINTI[t]!, next: k + 1 };
    if (NUMEROS[t] !== undefined) return { v: NUMEROS[t]!, next: k + 1 };
    return null;
  };
  if (w[j] === "mil") {
    total = 1000;
    j++;
  } else {
    const m = bajo(j);
    if (m && m.v < 10 && w[m.next] === "mil") {
      total = m.v * 1000;
      j = m.next + 1;
    }
  }
  if (CIENTOS[w[j] ?? ""] !== undefined) {
    total += CIENTOS[w[j]!]!;
    j++;
  }
  const b = bajo(j);
  if (b && (j > i || DECENAS[w[j] ?? ""] !== undefined || VEINTI[w[j] ?? ""] !== undefined)) {
    total += b.v;
    j = b.next;
  }
  return j > i && total > 0 ? { n: total, next: j } : null;
}

/** Cambia los numeros en letra compuestos o grandes por digitos ("doscientos cincuenta" -> "250", "mil 250" -> "1250"), SOLO en contexto de peso: seguidos de una unidad
 * ("mil quinientos gramos", "veinticinco kilos") o justo despues de kilos ("kilo doscientos cincuenta"). En cualquier otro lado ("mesa de cien personas") quedan como estaban;
 * los de una palabra que la gramatica ya conoce ("dos", "quince") tampoco cambian. */
function numerosEnLetraADigitos(w: readonly string[]): string[] {
  const salida: string[] = [];
  const esUnidad = (t: string | undefined) => UNIDAD_KG.test(t ?? "") || UNIDAD_G.test(t ?? "");
  for (let i = 0; i < w.length; ) {
    let r = numeroEnLetra(w, i);
    const sig = w[i + 1] ?? "";
    // "mil 250" = 1250 (el segundo numero ya viene en digitos)
    if (w[i] === "mil" && /^\d{1,3}$/.test(sig) && esUnidad(w[i + 2])) r = { n: 1000 + Number(sig), next: i + 2 };
    const enContexto = r !== null && (esUnidad(w[r.next]) || UNIDAD_KG.test(w[i - 1] ?? ""));
    if (r && enContexto && (r.next - i > 1 || NUMEROS[w[i]!] === undefined)) {
      salida.push(String(r.n));
      i = r.next;
    } else {
      salida.push(w[i]!);
      i++;
    }
  }
  return salida;
}

/** Prepara el texto: signos, diminutivos, fracciones Unicode, numero pegado a la unidad ("250g", "1kg", "2k"), puntuacion. */
function preparar(texto: string): string[] {
  const w = texto
    .replace(/[\u00bf?\u00a1!"\u201c\u201d()]/g, " ")
    .replace(/\b(kgs?|kgrs?|kilos?|kilogramos?|grs?|gramos?|g)\.(?=\s|$)/g, "$1")
    .replace(/(\d),(\d{3})(?=\s*(?:g|gr|grs|gramos?)\b)/g, "$1$2")
    .replace(/\bkilit([oa]s?)\b/g, (_m, f: string) => `kil${f}`)
    .replace(/\bcuartit([oa]s?)\b/g, (_m, f: string) => `cuart${f}`)
    .replace(/\bmitad\b/g, "medio")
    .replace(/\bquarto\b/g, "cuarto")
    .replace(/\b(kgs?|kilos?|kilogramos?)y\b/g, "$1 y")
    .replace(/\by(medio|media|cuartos?)\b/g, "y $1")
    .replace(/(\d)\s*\u00bd/g, "$1 y 1/2")
    .replace(/\u00bd/g, " 1/2 ")
    .replace(/\u00bc/g, " 1/4 ")
    .replace(/\u00be/g, " 3/4 ")
    .replace(/(\d)\s*k\b/g, "$1 kg")
    .replace(/(\d)\s*(kgs|kgrs|kgr|kg|kilogramos?|kilos?|grs|gr|gramos?|g)\b/g, "$1 $2")
    .replace(/(\d\/\d)\s*(kg|kilo)/g, "$1 $2")
    // La coma o el punto y coma CORTA la frase ("un kilo, 250 de bistec" son dos cosas): queda como separador "|" que nada de la gramatica consume.
    .replace(/[,;](?!\d)/g, " | ")
    .replace(/(?<!\d)[,;]/g, " | ")
    .split(/\s+/)
    .filter(Boolean);
  return numerosEnLetraADigitos(w);
}

const APROX_ANTES: ReadonlyArray<readonly string[]> = [["casi"], ["como"], ["aprox"], ["aproximadamente"], ["unos"], ["unas"], ["mas", "o", "menos"], ["poco", "mas", "de"], ["un", "poco", "mas", "de"], ["algo", "de"]];
const APROX_DESPUES: ReadonlyArray<readonly string[]> = [["y", "pico"], ["y", "poquito"], ["y", "tantito", "mas"], ["y", "tantito"], ["y", "un", "poco", "mas"], ["y", "un", "poco"], ["y", "algo"], ["y", "feria"], ["o", "menos"], ["mas", "o", "menos"], ["poquito", "mas"], ["un", "poco", "mas"], ["aprox"], ["aproximadamente"]];
const empiezaCon = (w: readonly string[], i: number, seq: readonly string[]) => seq.every((t, k) => w[i + k] === t);
/** Cuantas palabras de aproximacion ("casi", "mas o menos") terminan justo antes de `i`. */
function aproxAntes(w: readonly string[], i: number): number {
  let mejor = 0;
  for (const seq of APROX_ANTES) if (i - seq.length >= 0 && empiezaCon(w, i - seq.length, seq)) mejor = Math.max(mejor, seq.length);
  return mejor;
}
/** "y algo" / "y un poco" solo son aproximado pegados a la cantidad ("kilo y algo"); con "de ..." detras son otra cosa ("un kilo y algo de tomar", "y un poco de salsa"). */
const SOLO_SIN_DE: ReadonlySet<string> = new Set(["y algo", "y un poco"]);
function aproxDespues(w: readonly string[], i: number): number {
  let mejor = 0;
  for (const seq of APROX_DESPUES) {
    if (!empiezaCon(w, i, seq)) continue;
    if (SOLO_SIN_DE.has(seq.join(" ")) && w[i + seq.length] === "de") continue;
    mejor = Math.max(mejor, seq.length);
  }
  return mejor;
}
/** "2 y medio de pastor": el "medio" es de una cantidad sin unidad, no "medio kilo" por si solo. */
const esMedioDeOtraCantidad = (w: readonly string[], i: number) =>
  (w[i - 1] === "y" || w[i - 1] === "con") && aNumero(w[i - 2]) !== null && (esFraccionPalabra(w[i]) || FRACCION_BARRA[w[i] ?? ""] !== undefined);

/** Un numero que es de CONTEXTO y no la cantidad de la unidad que viene despues: "a las 3, kilo y cuarto", "para las 3 kilo...", "mesa 3 kilo de pastor", "mesa de 4", "son 3", "somos 4". */
const esNumeroDeContexto = (w: readonly string[], i: number): boolean => {
  if (aNumero(w[i]) === null) return false;
  const a = w[i - 1];
  const b = w[i - 2];
  // Si justo despues del numero viene una unidad de peso, es la CANTIDAD del pedido ("son 2 kilos de arrachera", "de la 2 kilos de pastor", "son 500 gramos"):
  // el contexto de mesa/hora no lleva unidad pegada. Solo "kilo"/"kilogramo" en singular detras de "las/la/somos" sigue siendo ambiguo ("a las 3 kilo y cuarto") y se queda como contexto.
  const u = w[i + 1] ?? "";
  if (a !== "mesa" && !(a === "de" && b === "mesa") && (UNIDAD_KG.test(u) || UNIDAD_G.test(u)) && (a === "son" || u !== "kilo" && u !== "kilogramo")) return false;
  return a === "mesa" || a === "son" || a === "somos" || ((a === "las" || a === "la") && (b === "a" || b === "para" || b === "en" || b === "de" || b === "como")) || (a === "de" && b === "mesa");
};
/** Una consulta mas larga que esto no es un pedido de cocina sino ruido: no se interpreta (evita trabajo cuadratico y recursion profunda). */
export const LARGO_MAX_CONSULTA_PESO = 500;

/** Reemplaza cada frase de peso por ` peso:<gramos> `; lo demas queda igual. Una frase aproximada sale como `peso:cualquiera`. Entrada que no es texto o es demasiado larga: sin cambios. */
export function normalizarPesos(textoSinAcentos: string): string {
  if (typeof textoSinAcentos !== "string") return "";
  if (textoSinAcentos.length > LARGO_MAX_CONSULTA_PESO) return textoSinAcentos;
  const w = preparar(textoSinAcentos);
  const salida: string[] = [];
  const deContexto = new Set<number>();
  for (let i = 0; i < w.length; ) {
    if (w[i] === "|") {
      i++;
      continue;
    }
    if (esNumeroDeContexto(w, i)) {
      deContexto.add(i);
      salida.push(w[i]!);
      i++;
      continue;
    }
    // "0 kg": el numero ya fallo (cero), la unidad sola no vale 1 kg. ("a las 3 kilo y cuarto": el 3 es de contexto, no de la unidad.)
    const unidadHuerfana = UNIDAD_KG.test(w[i] ?? "") && i > 0 && aNumero(w[i - 1]) !== null && !deContexto.has(i - 1);
    // "cuarto y kilo" (1.25 kg dicho al reves): no se adivina, el agente pregunta.
    const alReves = UNIDAD_KG.test(w[i] ?? "") && w[i - 1] === "y" && (esFraccionPalabra(w[i - 2]) || FRACCION_BARRA[w[i - 2] ?? ""] !== undefined);
    // "1 1/4 de pastor": una fraccion con un entero delante y SIN unidad ("1 1/4") no se lee como el cuarto suelto.
    const enteroMasFraccion = FRACCION_BARRA[w[i] ?? ""] !== undefined && /^\d+$/.test(w[i - 1] ?? "") && !deContexto.has(i - 1) && !UNIDAD_KG.test(w[i + 1] ?? "") && !UNIDAD_G.test(w[i + 1] ?? "");
    if (alReves || enteroMasFraccion) {
      salida.splice(salida.length - (alReves ? 1 : 1), 1);
      if (alReves) salida.splice(salida.length - 1, 1);
      salida.push("peso:cualquiera");
      i++;
      continue;
    }
    const f = esMedioDeOtraCantidad(w, i) || unidadHuerfana ? null : parseFrase(w, i);
    if (f && Number.isFinite(f.gramos) && f.gramos > 0 && f.gramos <= 100000) {
      const antes = aproxAntes(w, i);
      const despues = aproxDespues(w, f.next);
      if (antes > 0 || despues > 0) {
        if (antes > 0) salida.splice(salida.length - antes, antes);
        salida.push("peso:cualquiera");
        i = f.next + despues;
      } else {
        salida.push(`peso:${Math.round(f.gramos)}`);
        i = f.next;
      }
    } else {
      salida.push(w[i]!);
      i++;
    }
  }
  return salida.join(" ");
}
