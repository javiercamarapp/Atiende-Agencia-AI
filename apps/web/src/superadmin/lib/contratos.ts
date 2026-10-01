// Formato y captura del contrato por cliente (SA-43) SIN flotantes en dinero: la API habla en centavos MXN
// enteros y puntos base; aqui se convierte de y hacia texto con aritmetica de cadenas/enteros, nunca con
// `Number("12.34") * 100` (que da 1233.9999999999998 en algunos casos).

const MONTO_RE = /^\d{1,9}(\.\d{1,2})?$/u;
const PORCENTAJE_RE = /^\d{1,3}(\.\d{1,2})?$/u;
const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** "5900", "5,900.5" o "$5900.50" -> 590000 / 590050; texto invalido -> `undefined`. Vacio -> `undefined`. */
export function pesosACentavos(texto: string): number | undefined {
  const sinSimbolo = texto.trim().replace(/^\$/u, "");
  // Las comas solo valen como separador de miles bien formado ("5,900.50"), nunca sueltas ("1,5,5").
  if (sinSimbolo.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d+)?$/u.test(sinSimbolo)) return undefined;
  const limpio = sinSimbolo.replace(/,/gu, "");
  if (!MONTO_RE.test(limpio)) return undefined;
  const [enteros = "0", decimales = ""] = limpio.split(".");
  return Number(enteros) * 100 + Number(decimales.padEnd(2, "0"));
}

/** 590050 -> "5,900.50" (miles con coma, siempre 2 decimales, sin pasar por flotantes). */
export function centavosATexto(centavos: number): string {
  const enteros = Math.trunc(centavos / 100);
  const resto = Math.abs(centavos % 100);
  return `${enteros.toLocaleString("en-US")}.${String(resto).padStart(2, "0")}`;
}

export const centavosAPesos = (centavos: number | null): string => (centavos === null ? "—" : `$${centavosATexto(centavos)}`);

/** Valor de un input de monto a partir de centavos (sin separador de miles, editable). */
export function centavosAEditable(centavos: number): string {
  const enteros = Math.trunc(centavos / 100);
  const resto = centavos % 100;
  return resto === 0 ? String(enteros) : `${enteros}.${String(resto).padStart(2, "0")}`;
}

/** "12.5" -> 1250 puntos base; invalido o > 100 -> `undefined`. Vacio -> 0. */
export function porcentajeABp(texto: string): number | undefined {
  const limpio = texto.trim().replace(/%$/u, "");
  if (limpio === "") return 0;
  if (!PORCENTAJE_RE.test(limpio)) return undefined;
  const [enteros = "0", decimales = ""] = limpio.split(".");
  const bp = Number(enteros) * 100 + Number(decimales.padEnd(2, "0"));
  return bp <= 10_000 ? bp : undefined;
}

/** 1250 -> "12.5"; 1000 -> "10"; 0 -> "". */
export function bpAEditable(bp: number): string {
  if (bp === 0) return "";
  const enteros = Math.trunc(bp / 100);
  const resto = bp % 100;
  return resto === 0 ? String(enteros) : `${enteros}.${String(resto).padStart(2, "0").replace(/0$/u, "")}`;
}

export const bpATexto = (bp: number): string => (bp === 0 ? "—" : `${bpAEditable(bp)} %`);

/** "2026-10-16" -> "16/10/2026" sin pasar por `Date` (no hay corrimiento por zona horaria). */
export function fechaIsoATexto(iso: string | null): string {
  if (iso === null) return "sin fin";
  const m = FECHA_RE.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Mes `YYYY-MM` del dia de hoy en hora local del navegador. */
export function mesActual(ahora: Date = new Date()): string {
  return `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, "0")}`;
}
