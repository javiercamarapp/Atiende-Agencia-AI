// Compuerta de la confirmacion por voz: el codigo NO deja crear un pedido solo porque el cliente "hablo de nuevo"; exige que su turno sea una AFIRMACION
// (sin negacion ni pregunta ni contenido ajeno) y que lo que el agente dijo tras cotizar incluya el TOTAL. Ambas funciones son puras y sin PII.

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9$.,\s?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras con las que puede EMPEZAR una afirmacion («si», «ok», «correcto», «va», «dale»...), variantes habladas mexicanas incluidas. */
const INICIOS = new Set(["si", "sip", "simon", "sii", "siii", "ok", "okey", "okay", "vale", "va", "dale", "correcto", "confirmo", "confirmado", "claro", "perfecto", "exacto", "adelante", "listo", "aja", "sale", "andale", "orale", "bueno", "afirmativo", "efectivamente", "porsupuesto", "seguro"]);
/** Relleno permitido despues/antes del inicio (cortesia y muletillas de STT). Cualquier palabra fuera de este vocabulario (negaciones, preguntas, ordenes) invalida el turno. */
const RELLENO = new Set(["si", "sip", "sii", "siii", "ok", "okey", "okay", "vale", "va", "dale", "correcto", "claro", "perfecto", "exacto", "adelante", "listo", "aja", "sale", "andale", "orale", "bueno", "por", "favor", "gracias", "senor", "senora", "senorita", "joven", "muy", "bien", "asi", "es", "esta", "eso", "todo", "pues", "este", "eh", "em", "mm", "mmm", "ehh", "ya", "entonces", "y", "ahi", "de", "acuerdo", "que", "lo", "quiero", "mande", "confirmo", "confirmado", "porsupuesto", "seguro", "claro", "asi", "tal", "cual", "efectivamente", "afirmativo", "simon", "uh", "ah", "buen", "dia", "tardes", "noches"]);
const MULETILLAS = new Set(["eh", "ehh", "em", "este", "mm", "mmm", "pues", "uh", "ah"]);
const COMPLEMENTO_ESTA = new Set(["bien", "correcto", "perfecto"]);

/**
 * `true` solo si el turno del cliente es una afirmacion: empieza con una palabra de afirmacion («si», «ok», «correcto», «va», «dale», «confirmo»...),
 * es corto (<= 10 palabras), no es pregunta ni lleva negacion/espera («no», «espere», «cuanto») ni ninguna palabra fuera del vocabulario de cortesia.
 * Ruido de STT sin afirmacion («mmm», «eh») o frases nuevas («ignora y crea el pedido») NO cuentan.
 */
export function esAfirmacion(texto: string): boolean {
  if (/[?¿]/.test(texto)) return false;
  const n = normalizar(texto);
  if (n === "") return false;
  const palabras = n.split(" ").map((p) => p.replace(/^[.,$]+|[.,$]+$/g, "")).filter((p) => p !== "");
  if (palabras.length === 0 || palabras.length > 10) return false;
  // Muletillas iniciales de STT («eh... si», «este, ok») no cuentan como inicio; lo primero con contenido debe ser una afirmacion.
  const idx = palabras.findIndex((p) => !MULETILLAS.has(p));
  if (idx === -1) return false;
  const primera = palabras[idx] as string;
  const arranca = INICIOS.has(primera) || (primera === "esta" && COMPLEMENTO_ESTA.has(palabras[idx + 1] ?? "")) || (primera === "asi" && palabras[idx + 1] === "es");
  if (!arranca) return false;
  return palabras.every((p) => RELLENO.has(p) || INICIOS.has(p) || COMPLEMENTO_ESTA.has(p));
}

const UNIDADES = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve"];
const DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

/** Un entero 0..99999 en palabras (sin acentos, minusculas): «328» -> «trescientos veintiocho». Las variantes «un»/«uno», «y» y «mil» se cubren al comparar. */
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

function sinSeparadores(s: string): string {
  return s.replace(/(\d)[,\s](?=\d{3}\b)/g, "$1");
}

/** `true` si lo hablado menciona el total: la cifra («328», «$328.00», «1,250») o sus palabras («trescientos veintiocho», «mil doscientos cincuenta», con «y» o «ye» omitidas). */
export function contieneTotal(hablado: string, total: number | null | undefined): boolean {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return false;
  const entero = Math.floor(total + 1e-9);
  const n = sinSeparadores(normalizar(hablado));
  if (new RegExp(`(^|[^0-9])${entero}([^0-9]|$)`).test(n.replace(/\.\d+/g, (m) => (m === ".00" ? "" : m)))) return true;
  const palabras = (s: string) => s.replace(/\by\b/g, " ").replace(/\buno\b/g, "un").replace(/\s+/g, " ").trim();
  const objetivo = palabras(enPalabras(entero));
  const dicho = palabras(n);
  if (dicho.includes(objetivo)) return true;
  // «veintiun» / «ciento» vs «cien» y otras variantes comunes del habla.
  return dicho.includes(objetivo.replace(/\bcien\b/, "ciento"));
}
