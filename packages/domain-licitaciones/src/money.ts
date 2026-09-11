// Aritmética monetaria determinista — port literal de
// licitaciones/packages/expediente/src/money.ts (REQ-LIC-006/REQ-029 origen):
// todo el pipeline económico opera en centavos como `bigint`, nunca en
// `number` de punto flotante. Redondeo half-up explícito en el único punto
// donde se necesita (cálculo de IVA a partir de una tasa fraccionaria).

/** Cadena decimal con hasta 2 decimales, p. ej. "1234.56" o "1234". */
export type DecimalString = string;

const DECIMAL_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export function assertValidDecimalString(value: string): void {
  if (!DECIMAL_PATTERN.test(value.trim())) {
    throw new Error(`Cadena decimal inválida (se esperaba p.ej. "1234.56"): "${value}"`);
  }
}

/** Convierte una cadena decimal a centavos (`bigint`), validando el formato. */
export function toCents(value: DecimalString): bigint {
  const trimmed = value.trim();
  assertValidDecimalString(trimmed);
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPartRaw = ""] = unsigned.split(".");
  const fracPart = (fracPartRaw + "00").slice(0, 2);
  const cents = BigInt(intPart!) * 100n + BigInt(fracPart);
  return negative ? -cents : cents;
}

/** Convierte centavos (`bigint`) de vuelta a cadena decimal con 2 decimales fijos. */
export function fromCents(cents: bigint): DecimalString {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const intPart = abs / 100n;
  const fracPart = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${intPart.toString()}.${fracPart}`;
}

export function addCents(a: bigint, b: bigint): bigint {
  return a + b;
}

export function sumCents(values: bigint[]): bigint {
  return values.reduce((acc, v) => addCents(acc, v), 0n);
}

/** Multiplica un monto en centavos por una tasa fraccionaria (p. ej. IVA 0.16) con redondeo half-up al centavo. Solo válido para montos/tasas no negativos. */
export function multiplyRateHalfUp(cents: bigint, rate: number): bigint {
  if (cents < 0n) throw new Error("multiplyRateHalfUp solo admite montos no negativos");
  if (rate < 0) throw new Error("multiplyRateHalfUp solo admite tasas no negativas");
  const rateMicros = BigInt(Math.round(rate * 1_000_000));
  const product = cents * rateMicros;
  const divisor = 1_000_000n;
  const quotient = product / divisor;
  const remainder = product % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

/** Cota superior de `quantity` (EX-EXP-09 del origen): por encima, la conversión a micro-unidades vía `Math.round` puede perder precisión silenciosamente cerca de `Number.MAX_SAFE_INTEGER`. */
export const MAX_QUANTITY = 1e7;

/** Multiplica una cantidad (unidades, puede tener decimales) por un precio unitario en centavos, con half-up. */
export function multiplyQuantityHalfUp(unitPriceCents: bigint, quantity: number): bigint {
  if (unitPriceCents < 0n) throw new Error("multiplyQuantityHalfUp solo admite precios no negativos");
  if (quantity < 0) throw new Error("multiplyQuantityHalfUp solo admite cantidades no negativas");
  if (quantity > MAX_QUANTITY) {
    throw new Error(`multiplyQuantityHalfUp: quantity (${quantity}) excede la cota máxima admitida (${MAX_QUANTITY}); revise si es un error de captura.`);
  }
  const qtyMicros = BigInt(Math.round(quantity * 1_000_000));
  const product = unitPriceCents * qtyMicros;
  const divisor = 1_000_000n;
  const quotient = product / divisor;
  const remainder = product % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

export function compareCents(a: bigint, b: bigint): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
