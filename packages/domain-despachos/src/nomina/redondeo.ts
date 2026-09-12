// Redondeo a 2 decimales — puerto de `round(x, 2)` de Python, incluyendo
// round-half-to-even (banker's rounding) en empates EXACTOS.
//
// HALLAZGO DURANTE LA CONSTRUCCIÓN (no anticipado por el diseño, confirmado
// con casos reales y reproducibles del golden-set — no especulativo): a
// diferencia de declaraciones/isr-engine.ts (Fase 2), cuyo comentario dice
// "los 63 casos del golden-set NO contienen ningún empate exacto... así que
// esta implementación [half-away-from-zero] reproduce el Python real en la
// práctica", el golden-set de nómina (Fase 3) SÍ contiene un empate exacto
// real: INFONAVIT sobre SBC topado (2932.75×30×0.05 = 4399.125 — confirmado
// con `decimal.Decimal(valor)` en el intérprete real, que muestra el valor
// EXACTO del double como `4399.125` sin nada más, es decir, es un empate
// genuino, no solo su repr corta). Python `round(4399.125, 2)` da `4399.12`
// (12 es par); un redondeo naive "half away from zero" da `4399.13`.
//
// PRIMER INTENTO FALLIDO (documentado a propósito, para que nadie lo repita):
// decidir el empate a partir de `Number.prototype.toString()` (la
// representación decimal MÁS CORTA que hace round-trip al mismo double) NO
// basta — esa representación corta puede terminar en "...5" exacto sin que
// el valor EXACTO del double sea realmente esa fracción. Caso real que
// reventó ese primer intento: `4690.93/2` da `toString() === "2345.465"`,
// pero `decimal.Decimal(4690.93/2)` en Python muestra el valor EXACTO como
// `2345.46500000000014551915228366851806640625` — está LIGERAMENTE por
// ENCIMA de 2345.465, no es un empate — así que Python redondea hacia arriba
// (`2345.47`), pero decidir por la repr corta ("termina en 5, aplica
// half-to-even") daba `2345.46` (incorrecto). Verificado con el intérprete
// real antes de descartar ese enfoque.
//
// IMPLEMENTACIÓN CORRECTA: reconstruye el valor EXACTO del double a partir de
// sus bits IEEE-754 (signo, exponente, mantisa) con aritmética de enteros
// (`BigInt`) — todo double finito es un racional diádico (mantisa × 2^e), y
// su expansión decimal SIEMPRE termina (2^-k = 5^k × 10^-k), así que esto da
// la representación decimal EXACTA, sin las trampas de la repr corta. Con esa
// cadena exacta, el empate en el tercer decimal es inequívoco: solo es
// empate real si TODOS los dígitos después del segundo decimal son
// exactamente "5" seguido de puros ceros.
function exactDecimalParts(x: number): { intPart: string; fracPart: string } {
  if (x === 0) return { intPart: "0", fracPart: "" };

  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setFloat64(0, x);
  const bits = (BigInt(dv.getUint32(0)) << 32n) | BigInt(dv.getUint32(4));

  const rawExponent = Number((bits >> 52n) & 0x7ffn);
  const rawMantissa = bits & 0xfffffffffffffn;

  let mantissa: bigint;
  let exponent: number;
  if (rawExponent === 0) {
    // Subnormal — nunca ocurre en magnitudes de nómina, pero se maneja bien.
    mantissa = rawMantissa;
    exponent = -1074;
  } else {
    mantissa = rawMantissa | (1n << 52n);
    exponent = rawExponent - 1075; // 1023 (bias) + 52 (bits de mantisa)
  }

  let numerator: bigint;
  let fracDigitsCount: number;
  if (exponent >= 0) {
    numerator = mantissa << BigInt(exponent);
    fracDigitsCount = 0;
  } else {
    const k = -exponent;
    numerator = mantissa * 5n ** BigInt(k); // valor = numerator / 10^k
    fracDigitsCount = k;
  }

  let numStr = numerator.toString();
  if (fracDigitsCount === 0) {
    return { intPart: numStr, fracPart: "" };
  }
  if (numStr.length <= fracDigitsCount) {
    numStr = numStr.padStart(fracDigitsCount + 1, "0");
  }
  const intPart = numStr.slice(0, numStr.length - fracDigitsCount) || "0";
  const fracPart = numStr.slice(numStr.length - fracDigitsCount);
  return { intPart, fracPart };
}

/** Puerto de `round(x, 2)` de Python (round-half-to-even sobre el valor
 * EXACTO del double). Ver la nota larga arriba para la justificación
 * completa y los dos casos reales que la motivaron. */
export function r2(n: number): number {
  if (!Number.isFinite(n)) return n;
  if (n === 0) return 0;

  const negative = n < 0;
  const { intPart, fracPart } = exactDecimalParts(Math.abs(n));

  if (fracPart.length <= 2) {
    // Sin nada que redondear — el valor exacto ya tiene <=2 decimales
    // (ocurre para enteros y algunos racionales diádicos simples).
    return n;
  }

  const keep = fracPart.slice(0, 2).padEnd(2, "0");
  const rest = fracPart.slice(2);
  const firstRestDigit = rest[0]!;

  let roundUp: boolean;
  if (firstRestDigit > "5") {
    roundUp = true;
  } else if (firstRestDigit < "5") {
    roundUp = false;
  } else {
    const restAfterFive = rest.slice(1).replace(/0+$/, "");
    if (restAfterFive.length > 0) {
      roundUp = true; // hay dígitos distintos de cero tras el "5" -> no es empate
    } else {
      // Empate EXACTO (todo lo que sigue al "5" es cero) -> round half to even.
      const lastKeptDigit = Number(keep[1] ?? "0");
      roundUp = lastKeptDigit % 2 === 1;
    }
  }

  let combined = BigInt(intPart + keep);
  if (roundUp) combined += 1n;

  const combinedStr = combined.toString().padStart(3, "0");
  const newInt = combinedStr.slice(0, -2) || "0";
  const newFrac = combinedStr.slice(-2);
  const result = Number(`${newInt}.${newFrac}`);
  return negative ? -result : result;
}
