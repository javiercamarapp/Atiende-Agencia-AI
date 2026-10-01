// H-25 -- validacion ESTRICTA de lo que manda el LLM (o el cliente de voz) a las herramientas de reservas, y redaccion de datos
// sensibles. Nada de lo que escribe el modelo se confia: fechas de calendario reales, enteros acotados, texto sin caracteres de
// control y sin formas de tarjeta/identificacion. El precio NUNCA entra por aqui: no hay ningun campo de precio en las herramientas.
import { ReservasAgenteError } from "./tipos.ts";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_NIGHTS_HARD = 60;

/** Fecha YYYY-MM-DD que EXISTE en el calendario (rechaza 2031-02-30, 2031-13-01, 0000-01-01). */
export function isRealCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Noches entre dos fechas ISO (UTC calendario puro: sin horario de verano). */
export function nightsBetweenDates(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
}

export interface ValidStay {
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly nights: number;
}

/** Valida forma y orden de la estadia. La fecha "hoy" y los topes de la politica los valida la BASE (zona horaria de la property). */
export function validateStayDates(checkIn: unknown, checkOut: unknown): ValidStay {
  if (!isRealCalendarDate(checkIn) || !isRealCalendarDate(checkOut)) {
    throw new ReservasAgenteError("fechas_invalidas", "Las fechas deben ser reales y con formato AAAA-MM-DD.");
  }
  const nights = nightsBetweenDates(checkIn, checkOut);
  if (nights < 1) throw new ReservasAgenteError("fechas_invalidas", "La salida debe ser posterior a la llegada.");
  if (nights > MAX_NIGHTS_HARD) throw new ReservasAgenteError("estadia_muy_larga", "Estadia demasiado larga para el agente.");
  return { checkInDate: checkIn, checkOutDate: checkOut, nights };
}

/** Entero acotado (rechaza decimales, texto numerico, NaN, Infinity, negativos y cantidades absurdas). */
export function parseBoundedInt(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ReservasAgenteError("parametros_invalidos", `${field} debe ser un entero entre ${min} y ${max}.`);
  }
  return value;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Texto libre del huesped: sin caracteres de control/bidi, colapsa espacios, recorta. */
export function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

const PAN_RE = /\d(?:[ -]?\d){12,18}/;
const CURP_RE = /\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/i;
const RFC_RE = /\b[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}\b/i;
const PASSPORT_HINT_RE = /\b(pasaporte|passport|curp|ine|ife|licencia de conducir|cvv|cvc|nip|tarjeta)\b/i;

/** true si el texto trae algo con forma de tarjeta, CURP/RFC o la mencion de un documento: nunca se guarda ni se repite. */
export function looksSensitive(text: string): boolean {
  return PAN_RE.test(text) || CURP_RE.test(text) || RFC_RE.test(text) || PASSPORT_HINT_RE.test(text);
}

/** Sustituye formas sensibles por [REDACTADO] (para el resumen de un handoff: queda registro sin el dato). */
export function redactSensitive(text: string): string {
  return text
    .replace(/\d(?:[ -]?\d){12,18}/g, "[REDACTADO]")
    .replace(new RegExp(CURP_RE.source, "gi"), "[REDACTADO]")
    .replace(new RegExp(RFC_RE.source, "gi"), "[REDACTADO]");
}

/** Nombre opcional del huesped: <=120, sin digitos largos ni formas sensibles ni URL/correo. */
export function parseGuestName(value: unknown): string | null {
  const cleaned = cleanText(value, 120);
  if (cleaned === null) return null;
  if (looksSensitive(cleaned) || /\d{5,}/.test(cleaned) || /https?:\/\/|www\.|@/i.test(cleaned)) {
    throw new ReservasAgenteError("parametros_invalidos", "No se guardan datos de identificacion ni de pago por chat.");
  }
  return cleaned;
}

/** Telefono del contacto tal como llega por el canal (solo digitos y +). */
export function normalizeContactPhone(value: unknown): string {
  if (typeof value !== "string") throw new ReservasAgenteError("parametros_invalidos", "Telefono de contacto requerido.");
  const digits = value.replace(/[^\d+]/g, "");
  if (digits.length < 8 || digits.length > 20) throw new ReservasAgenteError("parametros_invalidos", "Telefono de contacto invalido.");
  return digits;
}

/** Nombre de tipo de cuarto que se devuelve al modelo: dato de configuracion, nunca una instruccion. */
export function sanitizeLabel(value: string): string {
  return value.replace(CONTROL_CHARS_RE, " ").replace(/[`<>{}[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** UUID v1-v8 con forma valida (rechaza ids inventados antes de tocar la base). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** "$1,234.56", "1234 pesos", "MXN 1,234": devuelve los importes mencionados en centavos. */
export function extractMoneyCents(text: string): number[] {
  const out: number[] = [];
  const re = /(?:\$|\bmxn\b|\busd\b|us\$)\s*(\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(?:pesos|mxn|usd|d[oó]lares)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? m[2] ?? "").replace(/\s/g, "");
    if (!raw) continue;
    const cents = parseAmountToCents(raw);
    if (cents !== null) out.push(cents);
  }
  return out;
}

function parseAmountToCents(raw: string): number | null {
  // ultimo separador seguido de 1-2 digitos al final = decimales; el resto son miles.
  const dec = /[.,](\d{1,2})$/.exec(raw);
  const intPart = dec ? raw.slice(0, raw.length - dec[0].length) : raw;
  const digits = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const whole = Number(digits);
  if (!Number.isSafeInteger(whole)) return null;
  const frac = dec ? Number((dec[1] ?? "0").padEnd(2, "0")) : 0;
  return whole * 100 + frac;
}
