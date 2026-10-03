// H-42 -- validacion ESTRICTA de lo que manda el navegador del huesped a la reserva directa publica. Nada del navegador se confia: fechas de
// calendario reales, enteros acotados, texto sin caracteres de control, ningun campo de precio (el precio SIEMPRE sale de la base) y ningun
// dato de tarjeta (solo un id de metodo de pago ya tokenizado en el navegador por la pasarela; un PAN nunca llega a este servidor).
import { cleanText, isRealCalendarDate, isUuid, looksSensitive, nightsBetweenDates, normalizeContactPhone, parseBoundedInt } from "../reservas-agente/validacion.ts";
import { ReservasAgenteError } from "../reservas-agente/tipos.ts";

export class ReservarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservarValidationError";
  }
}

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const PAYMENT_METHOD_RE = /^pm_[A-Za-z0-9_]{8,100}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,119}$/;
const MAX_NIGHTS_HARD = 60;

export interface StayQuery {
  readonly propiedad: string | null;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly nights: number;
  readonly guests: number;
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ReservarValidationError("El cuerpo debe ser un objeto JSON.");
  return raw as Record<string, unknown>;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ReservasAgenteError) throw new ReservarValidationError(err.message);
    throw err;
  }
}

function parseSlug(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !SLUG_RE.test(value)) throw new ReservarValidationError("propiedad: identificador invalido.");
  return value;
}

function parseStay(llegada: unknown, salida: unknown, huespedes: unknown, propiedad: unknown): StayQuery {
  if (!isRealCalendarDate(llegada) || !isRealCalendarDate(salida)) throw new ReservarValidationError("Las fechas deben ser reales y con formato AAAA-MM-DD.");
  const nights = nightsBetweenDates(llegada, salida);
  if (nights < 1) throw new ReservarValidationError("La salida debe ser posterior a la llegada.");
  if (nights > MAX_NIGHTS_HARD) throw new ReservarValidationError("Estadia demasiado larga para la reserva en linea.");
  const guests = wrap(() => parseBoundedInt(huespedes, 1, 20, "huespedes"));
  return { propiedad: parseSlug(propiedad), checkInDate: llegada, checkOutDate: salida, nights, guests };
}

/** Query string de la disponibilidad: `huespedes` llega como texto. */
export function parseDisponibilidadQuery(q: { llegada?: string; salida?: string; huespedes?: string; property?: string }): StayQuery {
  const guests = q.huespedes === undefined ? NaN : Number(q.huespedes);
  return parseStay(q.llegada, q.salida, Number.isInteger(guests) ? guests : q.huespedes, q.property);
}

export interface CotizacionRequest extends StayQuery {
  readonly roomTypeId: string;
}

export function parseCotizacionBody(raw: unknown): CotizacionRequest {
  const b = asRecord(raw);
  const stay = parseStay(b.llegada, b.salida, b.huespedes, b.propiedad);
  if (!isUuid(b.tipoHabitacionId)) throw new ReservarValidationError("tipoHabitacionId: identificador invalido.");
  return { ...stay, roomTypeId: b.tipoHabitacionId };
}

export interface ConfirmarRequest {
  readonly quoteToken: string;
  readonly guestName: string;
  readonly contactPhone: string;
  readonly contactEmail: string;
  /** Id de metodo de pago ya tokenizado por la pasarela en el navegador (nunca un PAN). Opcional: sin el, el hold queda pendiente de pago. */
  readonly paymentMethodToken: string | null;
  /** Honeypot lleno: es un robot; la ruta responde sin guardar nada. */
  readonly honeypot: boolean;
}

export function parseConfirmarBody(raw: unknown): ConfirmarRequest {
  const b = asRecord(raw);
  if (typeof b.sitioWeb === "string" && b.sitioWeb.trim() !== "") {
    return { quoteToken: "", guestName: "", contactPhone: "", contactEmail: "", paymentMethodToken: null, honeypot: true };
  }
  if (typeof b.quoteToken !== "string" || b.quoteToken.length < 20 || b.quoteToken.length > 900) throw new ReservarValidationError("quoteToken: invalido.");
  const h = asRecord(b.huesped);
  if (b.consentimientoAviso !== true) throw new ReservarValidationError("Debes aceptar el aviso de privacidad para reservar.");
  const name = cleanText(h.nombre, 120);
  if (!name || name.length < 2) throw new ReservarValidationError("nombre: entre 2 y 120 caracteres.");
  if (looksSensitive(name) || /\d{5,}/.test(name) || /https?:\/\/|www\.|@/i.test(name)) throw new ReservarValidationError("nombre: no captures datos de identificacion ni de pago.");
  const phone = wrap(() => normalizeContactPhone(h.telefono));
  const emailRaw = typeof h.correo === "string" ? h.correo.trim().toLowerCase() : "";
  if (emailRaw.length < 5 || emailRaw.length > 254 || !EMAIL_RE.test(emailRaw) || cleanText(emailRaw, 254) !== emailRaw) throw new ReservarValidationError("correo: debe ser un correo valido.");
  let paymentMethodToken: string | null = null;
  if (b.metodoPagoToken !== undefined && b.metodoPagoToken !== null && b.metodoPagoToken !== "") {
    if (typeof b.metodoPagoToken !== "string" || !PAYMENT_METHOD_RE.test(b.metodoPagoToken)) throw new ReservarValidationError("metodoPagoToken: debe ser un id de metodo de pago tokenizado por la pasarela.");
    paymentMethodToken = b.metodoPagoToken;
  }
  return { quoteToken: b.quoteToken, guestName: name, contactPhone: phone, contactEmail: emailRaw, paymentMethodToken, honeypot: false };
}

/** Idempotency-Key obligatoria en confirmar/cancelar (reintento de red o doble clic no duplica). */
export function parseIdempotencyKey(header: string | null | undefined): string {
  if (typeof header !== "string" || !IDEMPOTENCY_RE.test(header.trim())) throw new ReservarValidationError("Idempotency-Key: obligatoria (8 a 100 caracteres, letras, numeros, guion o guion bajo).");
  return header.trim();
}

/** El cuerpo de la cancelacion va vacio (`{}`): el unico dato es el token de la URL. Cualquier otra cosa se rechaza. */
export function parseCancelarVacio(raw: unknown): void {
  const b = asRecord(raw);
  if (Object.keys(b).length > 0) throw new ReservarValidationError("El cuerpo de la cancelacion debe ir vacio.");
}
