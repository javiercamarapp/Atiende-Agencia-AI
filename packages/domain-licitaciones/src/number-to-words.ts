// Motor propio de "cantidad con letra" en español mexicano — port literal de
// licitaciones/packages/expediente/src/number-to-words.ts (REQ-LIC: requerido
// por la carta de proposición económica, texto legal real). Determinista, sin
// dependencias externas — las librerías genéricas tipo num2words fallan en
// casos borde como "veintiún", "un millón" vs "un millones", centenas exactas
// "cien" vs "ciento".

const UNIDADES = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];

const DIEZ_A_DIECINUEVE = ["diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve"];

const DECENAS = ["", "", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];

const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

/** Convierte un entero 0-999 a palabras. */
function threeDigitsToWords(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cien";

  const c = Math.floor(n / 100);
  const resto = n % 100;
  const parts: string[] = [];
  if (c > 0) parts.push(CENTENAS[c]!);

  if (resto > 0) {
    if (resto < 10) {
      parts.push(UNIDADES[resto]!);
    } else if (resto < 20) {
      parts.push(DIEZ_A_DIECINUEVE[resto - 10]!);
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      if (u === 0) {
        parts.push(DECENAS[d]!);
      } else if (d === 2) {
        const veinteUnidad: Record<number, string> = {
          1: "veintiuno",
          2: "veintidós",
          3: "veintitrés",
          4: "veinticuatro",
          5: "veinticinco",
          6: "veintiséis",
          7: "veintisiete",
          8: "veintiocho",
          9: "veintinueve",
        };
        parts.push(veinteUnidad[u]!);
      } else {
        parts.push(`${DECENAS[d]} y ${UNIDADES[u]}`);
      }
    }
  }

  return parts.join(" ");
}

/**
 * Ajusta "uno" → "un"/"una" cuando precede a un sustantivo o a "mil"/"millón"
 * (incluye el caso pegado "veintiuno" → "veintiún"). Se comprueba el sufijo
 * "veintiuno" ANTES que el sufijo " uno", cubriendo tanto el caso aislado como
 * el fusionado al final de una cadena más larga.
 */
function apocopeUno(words: string, feminine: boolean): string {
  const veintiunoApocope = feminine ? "veintiuna" : "veintiún";
  if (words === "veintiuno") return veintiunoApocope;
  if (words.endsWith("veintiuno")) return words.slice(0, -"veintiuno".length) + veintiunoApocope;
  if (words === "uno") return feminine ? "una" : "un";
  if (words.endsWith(" uno")) return words.slice(0, -"uno".length) + (feminine ? "una" : "un");
  return words;
}

/**
 * Convierte un entero no negativo (hasta 999,999,999,999) a palabras en
 * español. El apócope de "uno" → "un"/"veintiún" solo se aplica cuando el
 * segmento antecede a un sustantivo dentro del propio número ("mil",
 * "millón"/"millones"); el segmento final de unidades/decenas/centenas NO se
 * apocopa (es la forma cardinal aislada: "treinta y uno", "mil uno").
 */
export function integerToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`integerToWords solo admite enteros no negativos: ${n}`);
  }
  if (n === 0) return "cero";
  if (n > 999_999_999_999) {
    throw new Error("integerToWords no soporta cantidades mayores a 999,999,999,999");
  }

  const millones = Math.floor(n / 1_000_000);
  const restoMillones = n % 1_000_000;
  const miles = Math.floor(restoMillones / 1000);
  const centenas = restoMillones % 1000;

  const parts: string[] = [];

  if (millones > 0) {
    if (millones === 1) {
      parts.push("un millón");
    } else {
      parts.push(`${apocopeUno(threeDigitsAndThousands(millones), false)} millones`);
    }
  }

  if (miles > 0) {
    if (miles === 1) {
      parts.push("mil");
    } else {
      parts.push(`${apocopeUno(threeDigitsToWords(miles), false)} mil`);
    }
  }

  if (centenas > 0) {
    parts.push(threeDigitsToWords(centenas));
  }

  return parts.join(" ").trim();
}

/** Los millones pueden a su vez tener miles/centenas (p. ej. 1,234 millones). */
function threeDigitsAndThousands(n: number): string {
  const miles = Math.floor(n / 1000);
  const resto = n % 1000;
  const parts: string[] = [];
  if (miles > 0) {
    parts.push(miles === 1 ? "mil" : `${threeDigitsToWords(miles)} mil`);
  }
  if (resto > 0) {
    parts.push(threeDigitsToWords(resto));
  }
  return parts.join(" ").trim();
}

/** Formatea un monto (en centavos, `bigint`) como cantidad con letra estándar de documentos mexicanos: "SON: <ENTERO> PESOS <CC>/100 M.N." */
export function centsToPesosWords(cents: bigint, currencyLabel: string = "PESOS 00/100 M.N."): string {
  if (cents < 0n) throw new Error("centsToPesosWords solo admite montos no negativos");
  const pesos = cents / 100n;
  const centavos = cents % 100n;
  if (pesos > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Monto demasiado grande para convertir a letra");
  }
  const pesosWords = apocopeUno(integerToWords(Number(pesos)), false);
  const centavosStr = centavos.toString().padStart(2, "0");
  const effectiveCurrencyLabel = pesos === 1n ? currencyLabel.replace(/\bPESOS\b/i, "PESO") : currencyLabel;
  const label = effectiveCurrencyLabel.includes("00/100") ? effectiveCurrencyLabel.replace("00/100", `${centavosStr}/100`) : `${effectiveCurrencyLabel} ${centavosStr}/100`;
  return `SON: ${pesosWords.toUpperCase()} ${label.toUpperCase()}`;
}
