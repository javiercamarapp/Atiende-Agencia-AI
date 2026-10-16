// Importes que el agente DICE en voz alta, para compararlos con los que devolvieron las herramientas (grader G_PRECIO_HABLADO).
// El agente de voz habla con cifras en palabras ("trescientos veintiocho pesos") o con digitos ("$328", "328 pesos"): se reconocen ambas
// formas SOLO cuando van pegadas a "peso(s)" o a "$", para no confundir cantidades de tacos, horas o numeros de calle con dinero.
// Recorrido lineal sobre palabras (sin expresiones regulares con cuantificadores anidados: la transcripcion es entrada no confiable).

const UNIDADES: Readonly<Record<string, number>> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const DECENAS: Readonly<Record<string, number>> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const CENTENAS: Readonly<Record<string, number>> = {
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500,
  seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};

const esPalabraNumero = (p: string): boolean => p in UNIDADES || p in DECENAS || p in CENTENAS || p === "mil" || p === "y";

/** Palabras numericas consecutivas -> valor entero (0..999,999), o null si no forman una cifra. */
export function numeroEnPalabras(palabras: readonly string[]): number | null {
  let total = 0;
  let actual = 0;
  let hubo = false;
  for (const p of palabras) {
    if (p === "y") continue;
    if (p === "mil") {
      total += (actual === 0 ? 1 : actual) * 1000;
      actual = 0;
      hubo = true;
    } else if (p in UNIDADES) {
      actual += UNIDADES[p]!;
      hubo = true;
    } else if (p in DECENAS) {
      actual += DECENAS[p]!;
      hubo = true;
    } else if (p in CENTENAS) {
      actual += CENTENAS[p]!;
      hubo = true;
    } else return null;
  }
  return hubo ? total + actual : null;
}

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Todos los importes en pesos que dice el texto, en el orden en que aparecen. */
export function importesHablados(texto: string): number[] {
  const t = normalizar(texto);
  const importes: number[] = [];
  // 1) Digitos: "$1,234.50", "$ 328", "328 pesos", "1,234 pesos".
  const re = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*pesos\b/g;
  for (const m of t.matchAll(re)) {
    const entero = (m[1] ?? m[3] ?? "").replaceAll(",", "");
    const dec = m[2] ?? m[4] ?? "";
    const v = Number(dec ? `${entero}.${dec}` : entero);
    if (Number.isFinite(v)) importes.push(v);
  }
  // 2) Palabras: las palabras numericas inmediatamente anteriores a "peso(s)".
  const palabras = t.split(/[^a-z0-9$]+/).filter((p) => p !== "");
  for (let i = 0; i < palabras.length; i++) {
    if (palabras[i] !== "peso" && palabras[i] !== "pesos") continue;
    let j = i;
    while (j > 0 && esPalabraNumero(palabras[j - 1]!)) j -= 1;
    const v = numeroEnPalabras(palabras.slice(j, i));
    if (v !== null) importes.push(v);
  }
  return importes;
}

// Palabras que pueden seguir a la cifra de un total sin cambiar su sentido ("ciento ochenta pesos", "doscientos en total", "ciento ochenta con envio").
const COLA_DE_TOTAL: ReadonlySet<string> = new Set(["peso", "pesos", "mxn", "mn", "en", "total", "todo", "con", "mas", "incluido", "incluida", "incluyendo", "y", "nada"]);
// Un total PARCIAL (antes del descuento, sin envio, subtotal) no es lo que paga el cliente.
const PARCIAL = /\b(?:antes|sin|previo|parcial|subtotal|excluyendo)\b/;

/**
 * Importes que el agente presenta COMO TOTAL a pagar, con o sin la palabra "pesos" ("su total queda en ciento ochenta", "son 180 en total",
 * "total: $179"). Una cifra cuenta solo si va pegada al marcador ("total", "a pagar", "queda en", "serian") dentro de la misma clausula y no es una
 * cantidad ("el total de 3 tacos"). Es la lectura que `importesHablados` no hace: aquella exige "pesos" o "$", y por telefono casi nunca se dice.
 */
export function importesDeTotalHablado(texto: string): number[] {
  const t = normalizar(texto).replace(/(\d),(?=\d{3}(?!\d))/g, "$1").replace(/:/g, " ");
  const out: number[] = [];
  for (const clausula of t.split(/[.,;!?¿¡\n]+/)) {
    if (PARCIAL.test(clausula)) continue;
    const tokens = clausula.split(/\s+/).filter((x) => x !== "");
    const marca = tokens.findIndex((tk, i) => /^total$/.test(tk) || (tk === "a" && tokens[i + 1] === "pagar") || /^(?:queda|quedan|quedaria|quedarian|saldria|saldrian|seria|serian)$/.test(tk));
    if (marca < 0) continue;
    let i = marca + 1;
    while (i < tokens.length) {
      const tk = tokens[i]!;
      const digitos = /^\$?(\d+(?:\.\d{1,2})?)$/.exec(tk);
      if (digitos) {
        const next = tokens[i + 1];
        if (next === undefined || COLA_DE_TOTAL.has(next)) out.push(Number(digitos[1]));
        break;
      }
      if (esPalabraNumero(tk) && tk !== "y") {
        let j = i;
        while (j < tokens.length && esPalabraNumero(tokens[j]!)) j += 1;
        while (j > i && tokens[j - 1] === "y") j -= 1;
        const v = numeroEnPalabras(tokens.slice(i, j));
        const next = tokens[j];
        if (v !== null && (next === undefined || COLA_DE_TOTAL.has(next))) out.push(v);
        break;
      }
      i += 1;
    }
  }
  return out;
}

/** Totales que devolvieron las herramientas: el campo `total` (no `line_total`, `subtotal` ni precios) a cualquier profundidad. */
export function totalesDe(valor: unknown, acumulado: number[] = [], profundidad = 0): number[] {
  if (profundidad > 8) return acumulado;
  if (Array.isArray(valor)) for (const v of valor) totalesDe(v, acumulado, profundidad + 1);
  else if (typeof valor === "object" && valor !== null) {
    for (const [k, v] of Object.entries(valor)) {
      if (k === "total" && typeof v === "number" && Number.isFinite(v)) acumulado.push(v);
      else totalesDe(v, acumulado, profundidad + 1);
    }
  }
  return acumulado;
}

/** Valores numericos de cualquier profundidad de lo que devolvio una herramienta (precios, totales, minimos). */
export function numerosDe(valor: unknown, acumulado: number[] = [], profundidad = 0): number[] {
  if (profundidad > 8) return acumulado;
  if (typeof valor === "number" && Number.isFinite(valor)) acumulado.push(valor);
  else if (Array.isArray(valor)) for (const v of valor) numerosDe(v, acumulado, profundidad + 1);
  else if (typeof valor === "object" && valor !== null) for (const v of Object.values(valor)) numerosDe(v, acumulado, profundidad + 1);
  return acumulado;
}
