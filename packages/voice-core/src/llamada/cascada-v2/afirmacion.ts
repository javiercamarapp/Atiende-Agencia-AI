// Compuerta de la confirmacion por voz: el codigo NO deja crear un pedido solo porque el cliente "hablo de nuevo"; exige que su turno sea una AFIRMACION PURA
// (sin negacion, pregunta, contenido nuevo ni letras no latinas) y que lo que el agente dijo tras cotizar incluya el TOTAL. Funciones puras y sin PII.
//
// Decision de producto (documentada): «sí, a nombre de Juan», «sí, en efectivo» o «sí dos» NO son afirmaciones puras: llevan contenido nuevo (un dato del pedido). La compuerta
// las bloquea y el agente debe releer el resumen con ese dato y pedir un «sí» limpio. Es el costo de que ningun texto ajeno pueda colar un pedido.

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `true` si el texto trae alguna letra que no sea latina basica o con acento comun (CJK, cirilico, formas de ancho completo...). Esas transcripciones no son afirmaciones. */
function tieneLetrasNoLatinas(texto: string): boolean {
  for (const ch of texto) {
    if (/\p{L}/u.test(ch) && !/[a-zA-ZáéíóúüñÁÉÍÓÚÜÑ]/.test(ch)) return true;
    if (/\p{N}/u.test(ch) && !/[0-9]/.test(ch)) return true;
  }
  return false;
}

/** Palabras con las que puede EMPEZAR una afirmacion (variantes habladas mexicanas incluidas). «bueno» NO esta: solo, no afirma nada. */
const INICIOS = new Set(["si", "sip", "simon", "sii", "siii", "ok", "okey", "okay", "vale", "va", "dale", "correcto", "confirmo", "confirmado", "claro", "perfecto", "exacto", "adelante", "listo", "aja", "sale", "andale", "orale", "afirmativo", "efectivamente", "seguro", "hagale", "arre", "proceda", "porsupuesto"]);
/** Inicios de varias palabras. */
const FRASES_INICIO: readonly (readonly string[])[] = [["de", "acuerdo"], ["muy", "bien"], ["es", "correcto"], ["todo", "correcto"], ["asi", "es"], ["esta", "bien"], ["esta", "correcto"], ["esta", "perfecto"], ["por", "supuesto"]];
/** Muletillas de STT que pueden anteceder a la afirmacion. */
const MULETILLAS = new Set(["eh", "ehh", "em", "este", "mm", "mmm", "pues", "uh", "ah", "bueno"]);
/** Relleno de cortesia permitido (sin contenido de pedido). Cualquier palabra fuera de este vocabulario invalida el turno. */
const RELLENO = new Set(["por", "favor", "gracias", "senor", "senora", "senorita", "joven", "muy", "bien", "asi", "es", "esta", "eso", "ese", "el", "total", "todo", "ya", "entonces", "y", "ahi", "de", "acuerdo", "que", "lo", "quiero", "mande", "tal", "cual", "buen", "dia", "tardes", "noches", "supuesto", "correcto", "perfecto"]);

function empiezaCon(palabras: readonly string[], i: number): boolean {
  const p = palabras[i] as string;
  if (INICIOS.has(p)) return true;
  return FRASES_INICIO.some((f) => f.every((w, k) => palabras[i + k] === w));
}

/**
 * `true` solo si el turno del cliente es una afirmacion pura: empieza con una palabra de afirmacion («si», «ok», «correcto», «va», «dale», «de acuerdo»...), es corto
 * (<= 10 palabras) y TODAS sus palabras son afirmacion o cortesia. No cuenta: negaciones («no», «cancela»), preguntas, numeros, nombres, formas de pago, letras no latinas
 * ni ruido sin afirmacion («mmm»). Un signo de pregunta solo se tolera en «¿si?», «¿ok?», «¿va?» (<= 3 palabras, todas afirmacion pura).
 */
export function esAfirmacion(texto: string): boolean {
  if (tieneLetrasNoLatinas(texto)) return false;
  const conPregunta = /[?¿]/.test(texto);
  const n = normalizar(texto);
  if (n === "") return false;
  const palabras = n.split(" ").filter((p) => p !== "");
  if (palabras.length === 0 || palabras.length > 10) return false;
  const idx = palabras.findIndex((p) => !MULETILLAS.has(p));
  if (idx === -1 || !empiezaCon(palabras, idx)) return false;
  if (!palabras.every((p) => RELLENO.has(p) || INICIOS.has(p) || MULETILLAS.has(p))) return false;
  if (conPregunta) return palabras.length <= 3 && palabras.every((p) => INICIOS.has(p));
  return true;
}

// ---- Numeros en espanol -------------------------------------------------------------------------------------------------------------------------------------------

const UNIDADES = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve"];
const DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

/** Un entero 0..99999 en palabras (sin acentos, minusculas): «328» -> «trescientos veintiocho». */
export function enPalabras(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99_999) return String(n);
  if (n < 30) return UNIDADES[n] as string;
  if (n < 100) {
    const d = Math.floor(n / 10);
    const u = n % 10;
    return u === 0 ? (DECENAS[d] as string) : `${DECENAS[d]} y ${UNIDADES[u]}`;
  }
  if (n === 100) return "cien";
  if (n < 1000) {
    const c = Math.floor(n / 100);
    const r = n % 100;
    return r === 0 ? (CENTENAS[c] as string) : `${CENTENAS[c]} ${enPalabras(r)}`;
  }
  const miles = Math.floor(n / 1000);
  const r = n % 1000;
  const cabeza = miles === 1 ? "mil" : `${enPalabras(miles)} mil`;
  return r === 0 ? cabeza : `${cabeza} ${enPalabras(r)}`;
}

/** Valor de cada palabra numerica ya normalizada. «un/uno/una» = 1, «veintiun/veintiuno/veintiuna» = 21, «cien/ciento» = 100: una sola forma por cantidad a ambos lados. */
const VALOR = new Map<string, number>();
for (let i = 0; i < UNIDADES.length; i++) VALOR.set(UNIDADES[i] as string, i);
for (const [alias, v] of [["un", 1], ["una", 1], ["veintiun", 21], ["veintiuna", 21], ["cien", 100], ["ciento", 100], ["dieciseis", 16]] as const) VALOR.set(alias, v);
for (let i = 3; i < DECENAS.length; i++) VALOR.set(DECENAS[i] as string, i * 10);
for (let i = 2; i < CENTENAS.length; i++) VALOR.set(CENTENAS[i] as string, i * 100);
const CENTENAS_SING = new Map<string, number>([["cientos", 100]]);

/** Interpreta una racha de palabras numericas («mil trescientos veintiocho» -> 1328). `null` si la racha no es un numero bien formado. */
function valorDeRacha(tokens: readonly string[]): number | null {
  let resultado = 0;
  let acc = 0;
  let ultimo = Number.POSITIVE_INFINITY; // ultimo valor sumado a `acc`: cada sumando debe ser menor que el anterior (nada de «veinte treinta»)
  let hayPalabra = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === "y") {
      // «y» solo une decena y unidad: «treinta y cinco».
      const ant = tokens[i - 1] === undefined ? undefined : VALOR.get(tokens[i - 1] as string);
      const sig = tokens[i + 1] === undefined ? undefined : VALOR.get(tokens[i + 1] as string);
      if (ant === undefined || sig === undefined || ant < 30 || ant % 10 !== 0 || ant >= 100 || sig < 1 || sig > 9) return null;
      continue;
    }
    if (t === "mil") {
      resultado += (acc === 0 ? 1 : acc) * 1000;
      if (acc >= 1000) return null;
      acc = 0;
      ultimo = Number.POSITIVE_INFINITY;
      hayPalabra = true;
      continue;
    }
    const v = VALOR.get(t) ?? CENTENAS_SING.get(t);
    if (v === undefined) return null;
    if (v >= ultimo && !(ultimo === Number.POSITIVE_INFINITY)) return null;
    acc += v;
    ultimo = v;
    hayPalabra = true;
  }
  return hayPalabra ? resultado + acc : null;
}

/** Todas las cantidades (palabras y cifras) que menciona el texto. */
function cantidadesMencionadas(hablado: string): number[] {
  const out: number[] = [];
  // Cifras: «328», «$328.00», «1,250». «1.328» es 1.328 (no 328) y «.328» no es una cifra independiente.
  const reCifra = /(?<![\d.,])\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?!\d)/g;
  const crudo = hablado.toLowerCase();
  for (const m of crudo.matchAll(reCifra)) {
    const entero = Number((m[1] as string).replace(/,/g, ""));
    const frac = m[2] === undefined ? 0 : Number(`0.${m[2]}`);
    out.push(entero + frac);
  }
  // Palabras: rachas maximales de palabras numericas (con «y» interna).
  const tokens = normalizar(hablado).split(" ").filter((t) => t !== "");
  const esNum = (t: string): boolean => VALOR.has(t) || t === "mil" || CENTENAS_SING.has(t);
  let racha: string[] = [];
  const cerrar = (): void => {
    while (racha[racha.length - 1] === "y") racha.pop();
    if (racha.length > 0) {
      const v = valorDeRacha(racha);
      if (v !== null) out.push(v);
    }
    racha = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (esNum(t)) racha.push(t);
    else if (t === "y" && racha.length > 0 && esNum(tokens[i + 1] ?? "")) racha.push(t);
    else cerrar();
  }
  cerrar();
  return out;
}

/** `true` si lo hablado menciona el total COMPLETO: la cifra («328», «$328.00», «1,250») o sus palabras. Compara cantidades enteras, no subcadenas: «mil trescientos veintiocho» NO es 328. */
export function contieneTotal(hablado: string, total: number | null | undefined): boolean {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return false;
  const objetivo = Math.round(total * 100) / 100;
  const entero = Math.floor(objetivo + 1e-9);
  const hayCentavos = Math.abs(objetivo - entero) > 1e-9;
  return cantidadesMencionadas(hablado).some((c) => Math.abs(c - objetivo) < 0.005 || (hayCentavos && Number.isInteger(c) && c === entero));
}
