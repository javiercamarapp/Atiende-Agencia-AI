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
const RELLENO = new Set(["por", "favor", "gracias", "amable", "senor", "senora", "senorita", "joven", "muy", "bien", "asi", "es", "esta", "eso", "ese", "el", "total", "todo", "ya", "entonces", "y", "ahi", "de", "acuerdo", "que", "lo", "quiero", "mande", "tal", "cual", "buen", "dia", "tardes", "noches", "supuesto", "correcto", "perfecto"]);

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

/** Frases con las que el cliente RECHAZA o CANCELA el pedido (no una simple pausa como «no, espere»). Se evalua sobre el texto normalizado (sin acentos ni signos). */
const RECHAZOS: readonly RegExp[] = [
  /\bcancel\w*/,
  /\bya no\b/,
  /\bmejor no\b/,
  /\bno (lo |la |los |las )?(quiero|quiere|quieren|queremos|voy|va|me interesa|me lo|gracias)\b/,
  /\bno no\b/,
  /\bolvid\w*/,
  /\bdej(a|e|alo|elo|ala|ela)\b/,
  /\bdescart\w*/,
  /\bdeshaz\w*|\bdeshac\w*/,
  /\bni madres\b|\bnel\b/,
];

/**
 * `true` si el turno del cliente rechaza o cancela el pedido («cancela», «ya no», «mejor no», «no lo quiero», «olvidalo», «no gracias»...). Es DISTINTO de una pausa («no, espere»,
 * «un momento»): tras un rechazo el resumen que se leyo deja de estar vigente y solo una cotizacion nueva, su lectura y un «si» nuevo pueden abrir la compuerta.
 */
export function esRechazo(texto: string): boolean {
  const n = normalizar(texto);
  if (n === "") return false;
  return RECHAZOS.some((r) => r.test(n));
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
      if (ant === undefined || sig === undefined || ant < 20 || ant % 10 !== 0 || ant >= 100 || sig < 1 || sig > 9) return null;
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

const FIN_FRASE = /^(?:\s*[.,;:?!¿¡)]|\s*$)/;

/** Cantidades de las cifras del texto: «328», «$328.00», «1,250», «1 328» (miles con espacio). «1.328» es 1.328 y «.328» no es cifra; «328 mil» vale 328 000; «328 con 50 centavos» vale 328.50. */
function cantidadesEnCifras(texto: string): number[] {
  const out: number[] = [];
  const re = /(?<![\d.,])\$?\s?(\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.(\d+))?(?!\d)/g;
  for (const m of texto.matchAll(re)) {
    const entero = Number((m[1] as string).replace(/[, ]/g, ""));
    let valor = entero + (m[2] === undefined ? 0 : Number(`0.${m[2]}`));
    const resto = texto.slice((m.index ?? 0) + m[0].length);
    if (/^\s*mil\b/i.test(resto)) valor = entero * 1000;
    else {
      // «328 con 50 centavos», «328 pesos con 50»: los centavos forman parte de la cantidad (no se acepta 328 a secas como 328.50).
      const c = /^\s*(?:pesos\s*)?(?:con|y|punto)\s+(\d{1,2})(?:\s*centavos|\s*\/\s*100)?/i.exec(resto);
      if (c) {
        const despues = resto.slice(c[0].length);
        if (/centavos|\/\s*100/i.test(c[0]) || FIN_FRASE.test(despues)) valor = entero + Number(c[1]) / 100;
      }
    }
    out.push(valor);
  }
  return out;
}

/** Cantidades de las palabras del texto: rachas maximales de palabras numericas. Una coma entre un digito suelto y centenas («tres, cuatrocientos veintiocho») es «mil»; «con cincuenta [centavos]» al final suma centavos. */
function cantidadesEnPalabras(texto: string): number[] {
  const out: number[] = [];
  const crudo = texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const tokens = crudo.match(/[a-z]+|[.,;:?!]/g) ?? [];
  const esNum = (t: string | undefined): boolean => t !== undefined && (VALOR.has(t) || t === "mil" || CENTENAS_SING.has(t));
  const esCentena = (t: string | undefined): boolean => t !== undefined && (((VALOR.get(t) ?? 0) >= 100 && (VALOR.get(t) ?? 0) % 100 === 0) || t === "ciento");
  let i = 0;
  const leerRacha = (desde: number): { tokens: string[]; fin: number } => {
    const r: string[] = [];
    let j = desde;
    while (j < tokens.length) {
      const t = tokens[j] as string;
      if (esNum(t)) r.push(t);
      else if (t === "y" && r.length > 0 && esNum(tokens[j + 1])) r.push(t);
      else if (t === "," && r.length === 1 && (VALOR.get(r[0] as string) ?? 0) >= 1 && (VALOR.get(r[0] as string) ?? 0) <= 9 && esCentena(tokens[j + 1])) r.push("mil");
      else break;
      j++;
    }
    while (r[r.length - 1] === "y") r.pop();
    return { tokens: r, fin: j };
  };
  while (i < tokens.length) {
    if (!esNum(tokens[i])) {
      i++;
      continue;
    }
    const { tokens: racha, fin } = leerRacha(i);
    i = Math.max(fin, i + 1);
    const v = valorDeRacha(racha);
    if (v === null) continue;
    // Centavos: «<total> [pesos] con <N> [centavos]» (N de 1 a 99 y fin de frase o «centavos»): la cantidad es total + N/100.
    let j = fin;
    if (tokens[j] === "pesos") j++;
    if (tokens[j] === "con" || tokens[j] === "y" || tokens[j] === "punto") {
      const c = leerRacha(j + 1);
      const n = c.tokens.length > 0 ? valorDeRacha(c.tokens) : null;
      if (n !== null && n >= 1 && n <= 99 && (tokens[c.fin] === "centavos" || tokens[c.fin] === undefined || /^[.,;:?!]$/.test(tokens[c.fin] as string))) {
        out.push(v + n / 100);
        i = c.fin;
        continue;
      }
    }
    out.push(v);
  }
  return out;
}

/**
 * `true` si lo hablado menciona el total COMPLETO: la cifra («328», «$328.00», «1,250», «1 328») o sus palabras («mil doscientos cincuenta», «tres, cuatrocientos veintiocho»).
 * Compara la CANTIDAD completa, centavos incluidos: «mil trescientos veintiocho» o «328 mil» no son 328; «328 con cincuenta» no es 328 ni 328 a secas es 328.50.
 */
export function contieneTotal(hablado: string, total: number | null | undefined): boolean {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return false;
  const objetivo = Math.round(total * 100) / 100;
  return [...cantidadesEnCifras(hablado), ...cantidadesEnPalabras(hablado)].some((c) => Math.abs(c - objetivo) < 0.005);
}
