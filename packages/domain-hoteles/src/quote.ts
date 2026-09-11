// Port de hoteles/packages/domain-hotel/src/quote.ts (H4). Motor de cotización
// determinista (REQ-RES-002/REQ-REV-001): noches × tarifa de `hoteles.rate_plan` (una
// fila real por noche, jamás inventada) + impuestos configurables (taxes.ts). Ninguna
// ruta de este módulo acepta ni usa un precio "sugerido" por un LLM.
//
// ADAPTACIÓN DELIBERADA vs. el origen: el origen usa zod (`nightlyRateSchema.strip()`)
// para descartar cualquier campo no reconocido de una fila de tarifa antes de que
// llegue al cálculo. Esta migración NO añade zod como dependencia nueva del monorepo
// (ninguna otra ruta/paquete de atiende-fusion lo usa — ver
// apps/api/src/routes/verticals/restaurantes/public.ts, que valida a mano campo por
// campo). `parseQuoteInput` reproduce la MISMA garantía estructural por construcción:
// nunca hace `{...raw}` — arma un objeto nuevo leyendo únicamente las columnas reales
// de `rate_plan` (`date`,`price`,`minStay`,`closedToArrival`,`closedToDeparture`), así
// que un campo extra (ej. `llmSuggestedPrice`) es estructuralmente imposible que llegue
// a `computeQuote`, con o sin librería de validación.
import { applyTaxes, assertValidTaxConfig, type TaxBreakdown } from "./taxes.ts";
import { roundCurrency } from "./money.ts";

export class QuoteError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "QuoteError";
    this.code = code;
  }
}

/** Error de validación de forma del input (equivalente a un `ZodError` del origen) —
 *  distinto de `QuoteError`, que son errores de REGLA DE NEGOCIO sobre un input ya
 *  bien formado. */
export class QuoteInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteInputValidationError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDateString(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new QuoteInputValidationError(`${field}: formato de fecha esperado YYYY-MM-DD`);
  }
  return value;
}

export interface NightlyRate {
  date: string;
  price: number;
  minStay: number;
  closedToArrival: boolean;
  closedToDeparture: boolean;
}

/** Espejo exacto (y únicamente) de las columnas de `hoteles.rate_plan` relevantes para
 *  cotizar. Cualquier propiedad fuera de esta lista (ej. un precio propuesto por el
 *  LLM de un canal conversacional) nunca se lee de `raw` — se construye un objeto
 *  nuevo campo por campo. */
function parseNightlyRate(raw: unknown, index: number): NightlyRate {
  if (typeof raw !== "object" || raw === null) {
    throw new QuoteInputValidationError(`nightlyRates[${index}]: se esperaba un objeto`);
  }
  const r = raw as Record<string, unknown>;
  const date = assertDateString(r.date, `nightlyRates[${index}].date`);
  if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price < 0) {
    throw new QuoteInputValidationError(`nightlyRates[${index}].price: se esperaba un número >= 0`);
  }
  const minStayRaw = r.minStay;
  const minStay = minStayRaw === undefined ? 1 : minStayRaw;
  if (typeof minStay !== "number" || !Number.isInteger(minStay) || minStay <= 0) {
    throw new QuoteInputValidationError(`nightlyRates[${index}].minStay: se esperaba un entero > 0`);
  }
  const closedToArrival = r.closedToArrival === undefined ? false : r.closedToArrival;
  if (typeof closedToArrival !== "boolean") {
    throw new QuoteInputValidationError(`nightlyRates[${index}].closedToArrival: se esperaba boolean`);
  }
  const closedToDeparture = r.closedToDeparture === undefined ? false : r.closedToDeparture;
  if (typeof closedToDeparture !== "boolean") {
    throw new QuoteInputValidationError(`nightlyRates[${index}].closedToDeparture: se esperaba boolean`);
  }
  return { date, price: r.price, minStay, closedToArrival, closedToDeparture };
}

function parseTaxConfig(raw: unknown): { ivaRate: number; ishRate: number } {
  if (typeof raw !== "object" || raw === null) {
    throw new QuoteInputValidationError("taxConfig: se esperaba un objeto");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.ivaRate !== "number" || r.ivaRate < 0) {
    throw new QuoteInputValidationError("taxConfig.ivaRate: se esperaba un número >= 0");
  }
  if (typeof r.ishRate !== "number" || r.ishRate < 0) {
    throw new QuoteInputValidationError("taxConfig.ishRate: se esperaba un número >= 0");
  }
  return { ivaRate: r.ivaRate, ishRate: r.ishRate };
}

export interface QuoteInput {
  checkInDate: string;
  checkOutDate: string;
  currency: string;
  nightlyRates: readonly NightlyRate[];
  taxConfig: { ivaRate: number; ishRate: number };
}

export interface QuoteNightBreakdown {
  date: string;
  price: number;
}

export interface Quote extends TaxBreakdown {
  nights: number;
  currency: string;
  nightlyBreakdown: QuoteNightBreakdown[];
}

/** Descarta cualquier campo no reconocido (ej. un precio sugerido por un LLM) antes de
 *  que el valor llegue a `computeQuote` — nunca por omisión de un `.strip()`, sino
 *  porque el objeto resultante se construye leyendo únicamente los campos permitidos
 *  (ver comentario de cabecera). Lanza `QuoteInputValidationError` si falta un campo
 *  requerido o tiene un tipo inválido. */
export function parseQuoteInput(raw: unknown): QuoteInput {
  if (typeof raw !== "object" || raw === null) {
    throw new QuoteInputValidationError("se esperaba un objeto");
  }
  const r = raw as Record<string, unknown>;
  const checkInDate = assertDateString(r.checkInDate, "checkInDate");
  const checkOutDate = assertDateString(r.checkOutDate, "checkOutDate");
  const currency = r.currency === undefined ? "MXN" : r.currency;
  if (typeof currency !== "string") throw new QuoteInputValidationError("currency: se esperaba string");
  if (!Array.isArray(r.nightlyRates) || r.nightlyRates.length < 1) {
    throw new QuoteInputValidationError("nightlyRates: se esperaba un arreglo con al menos un elemento");
  }
  const nightlyRates = r.nightlyRates.map((entry, index) => parseNightlyRate(entry, index));
  const taxConfig = parseTaxConfig(r.taxConfig);

  if (checkOutDate <= checkInDate) {
    throw new QuoteInputValidationError("checkOutDate debe ser posterior a checkInDate");
  }

  return { checkInDate, checkOutDate, currency, nightlyRates, taxConfig };
}

/** Fechas UTC calendario puras (sin componente de hora): evita que un cambio de
 *  horario de verano local duplique o elimine una noche. */
export function nightsBetween(checkInDate: string, checkOutDate: string): string[] {
  const nights: string[] = [];
  const cursor = new Date(`${checkInDate}T00:00:00Z`);
  const end = new Date(`${checkOutDate}T00:00:00Z`);
  while (cursor < end) {
    nights.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

/**
 * Cotiza una estadía de forma 100% determinista a partir de tarifas y configuración
 * fiscal REALES (nunca inventadas ni redondeadas/ajustadas por un LLM, REQ-REV-001).
 * Valida min-stay/CTA/CTD (H07-005) y rechaza una estadía de 0 noches.
 */
export function computeQuote(input: QuoteInput): Quote {
  assertValidTaxConfig(input.taxConfig);
  // Repite la validación de `parseQuoteInput` aquí porque `computeQuote` es una
  // función pública exportada por su cuenta (no todo llamador pasa primero por
  // `parseQuoteInput`) — una estadía de 0 noches se rechaza sin importar la vía de
  // entrada.
  if (input.checkOutDate <= input.checkInDate) {
    throw new QuoteError("estadia_invalida", "checkOutDate debe ser posterior a checkInDate.");
  }
  const nights = nightsBetween(input.checkInDate, input.checkOutDate);
  if (nights.length < 1) {
    throw new QuoteError("estadia_invalida", "La estadía debe ser de al menos 1 noche.");
  }

  const ratesByDate = new Map(input.nightlyRates.map((r) => [r.date, r]));

  const arrivalRate = ratesByDate.get(input.checkInDate);
  if (!arrivalRate) {
    throw new QuoteError("sin_tarifa", `No hay tarifa configurada para la fecha de llegada ${input.checkInDate}.`);
  }
  if (arrivalRate.closedToArrival) {
    throw new QuoteError("cerrado_a_llegada", `El ${input.checkInDate} está cerrado a llegadas (CTA).`);
  }
  if (nights.length < arrivalRate.minStay) {
    throw new QuoteError(
      "estadia_minima_no_alcanzada",
      `Esta tarifa exige una estadía mínima de ${arrivalRate.minStay} noche(s); se solicitaron ${nights.length}.`,
    );
  }

  const departureRate = ratesByDate.get(input.checkOutDate);
  if (departureRate?.closedToDeparture) {
    throw new QuoteError("cerrado_a_salida", `El ${input.checkOutDate} está cerrado a salidas (CTD).`);
  }

  const nightlyBreakdown: QuoteNightBreakdown[] = [];
  let netSubtotal = 0;
  for (const date of nights) {
    const rate = ratesByDate.get(date);
    if (!rate) {
      throw new QuoteError("sin_tarifa", `No hay tarifa configurada para la noche ${date}.`);
    }
    nightlyBreakdown.push({ date, price: rate.price });
    netSubtotal = roundCurrency(netSubtotal + rate.price);
  }

  const taxes = applyTaxes(netSubtotal, input.taxConfig);

  return {
    nights: nights.length,
    currency: input.currency,
    nightlyBreakdown,
    ...taxes,
  };
}
