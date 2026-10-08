// CFO-04 · utilidades numéricas, de formato y de fechas del dominio puro del CFO.
//
// REGLAS (diseño §3):
//  - Todo monto es un ENTERO en centavos. Nunca se opera con pesos flotantes.
//  - Redondeo de la casa: MEDIO HACIA ARRIBA EN VALOR ABSOLUTO ("half away from zero"): 0.5 -> 1, -0.5 -> -1.
//    Se hace con aritmética entera (`divEntera`, `mulDiv`) para que no haya sorpresas de punto flotante.
//  - Las razones (porcentajes) se calculan SIEMPRE desde sumas (Σ numerador / Σ denominador), con 1 decimal.
//  - Si el denominador es 0 el resultado es `null` ("sin datos"), NUNCA 0.
//  - Sin `toLocale*` (hay un guard de formato único): el formato es-MX se arma a mano, determinista.
//  - Sin reloj: ninguna función de este paquete llama a `Date.now()` ni `new Date()` sin argumento.
import { diaSemanaIso, fechaNegocioValida, sumarDiasFecha } from "../cierres/cierre.ts";
import type { Cifra, Confianza } from "./tipos.ts";

export { diaSemanaIso, fechaNegocioValida, sumarDiasFecha };

// ---- Aritmética entera -------------------------------------------------------------------------------------------------------------------

/** División entera redondeada "half away from zero". `den` debe ser distinto de 0. Exacta mientras |num| < 2^53. */
export function divEntera(num: number, den: number): number {
  if (den === 0) throw new RangeError("divEntera: denominador 0");
  const signo = num < 0 !== den < 0 ? -1 : 1;
  const n = Math.abs(num);
  const d = Math.abs(den);
  let q = Math.floor(n / d);
  const r = n - q * d;
  if (r * 2 >= d) q += 1;
  return q === 0 ? 0 : signo * q;
}

/** a × b ÷ c con BigInt (sin desbordar 2^53) y redondeo "half away from zero". `c` ≠ 0. */
export function mulDiv(a: number, b: number, c: number): number {
  if (c === 0) throw new RangeError("mulDiv: denominador 0");
  const A = BigInt(Math.trunc(a));
  const B = BigInt(Math.trunc(b));
  const C = BigInt(Math.trunc(c));
  let num = A * B;
  let den = C;
  let neg = false;
  if (num < 0n) { num = -num; neg = !neg; }
  if (den < 0n) { den = -den; neg = !neg; }
  let q = num / den;
  const r = num - q * den;
  if (r * 2n >= den) q += 1n;
  const out = Number(q);
  return out === 0 ? 0 : neg ? -out : out;
}

/** Redondea un número cualquiera a entero, "half away from zero". Solo para estimaciones; los montos usan `divEntera`/`mulDiv`. */
export function redondear(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError("redondear: no finito");
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return r === 0 ? 0 : r;
}

export function esEntero(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n);
}

/** Σ de enteros; ignora null/undefined. */
export function suma(xs: ReadonlyArray<number | null | undefined>): number {
  let s = 0;
  for (const x of xs) if (x != null) s += x;
  return s;
}

/** Porcentaje con 1 decimal de num/den (num y den enteros). Devuelve null si den ≤ 0. Ej.: pct1(1, 3) = 33.3. */
export function pct1(num: number, den: number): number | null {
  if (!(den > 0)) return null;
  return mulDiv(num, 1000, den) / 10;
}

/** num/den con 1 decimal (no porcentaje). null si den ≤ 0. Ej.: razon1(10, 4) = 2.5. */
export function razon1(num: number, den: number): number | null {
  if (!(den > 0)) return null;
  return mulDiv(num, 10, den) / 10;
}

/** Comparador de cadenas por punto de código: determinista en cualquier runtime/locale (a diferencia de `localeCompare`). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- Cifras ------------------------------------------------------------------------------------------------------------------------------

export function cifra(valor: number | null, confianza: Confianza, fuente: string): Cifra {
  if (valor === null) return { valor: null, confianza: "sin_dato", fuente };
  return { valor, confianza, fuente };
}

export function sinDato(fuente: string): Cifra {
  return { valor: null, confianza: "sin_dato", fuente };
}

const ORDEN_CONFIANZA: Readonly<Record<Confianza, number>> = { medido: 0, importado: 1, capturado: 2, estimado: 3, sin_dato: 4 };

/** La confianza combinada de varias cifras es la MENOS confiable entre las que sí tienen dato. Sin ninguna con dato: `sin_dato`. */
export function combinarConfianza(cs: ReadonlyArray<Confianza>): Confianza {
  let peor: Confianza | null = null;
  for (const c of cs) {
    if (c === "sin_dato") continue;
    if (peor === null || ORDEN_CONFIANZA[c] > ORDEN_CONFIANZA[peor]) peor = c;
  }
  return peor ?? "sin_dato";
}

// ---- Formato es-MX (sin Intl ni toLocale: determinista en cualquier runtime) ------------------------------------------------------------

function agruparMiles(entero: string): string {
  let out = "";
  for (let i = 0; i < entero.length; i++) {
    if (i > 0 && (entero.length - i) % 3 === 0) out += ",";
    out += entero[i];
  }
  return out;
}

/** Minutos (numeric con hasta 2 decimales, p. ej. 100.99) -> centésimas ENTERAS. Es la forma en que se opera todo lo que lleva minutos. */
export function centesimas(x: number): number {
  return redondear(x * 100);
}

/** Σ exacta de valores con hasta 2 decimales (suma en centésimas enteras; evita 7801.700000000001 ≠ 7801.699999999999). */
export function sumaDecimal2(xs: ReadonlyArray<number | null | undefined>): number {
  let c = 0;
  for (const x of xs) if (x != null) c += centesimas(x);
  return c / 100;
}

/** Promedio de minutos con 1 decimal desde una suma con ≤ 2 decimales: Σ/n con redondeo half away from zero, en enteros. */
export function promedioMin1(sumaMin: number, n: number): number | null {
  if (!(n > 0)) return null;
  return divEntera(centesimas(sumaMin), n * 10) / 10;
}

/** Los `numeric` de Postgres llegan como string con node-postgres: conviértalos aquí. null/"" -> null; no numérico -> lanza. */
export function numericoSql(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new TypeError(`numeric inválido: ${String(v)}`);
  // Un entero fuera de ±2^53 ya perdió precisión al convertirse a number: mejor fallar claro que mostrar una cifra distinta.
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) throw new RangeError(`bigint fuera del rango seguro de number (2^53): ${String(v)}`);
  return n;
}

/** n1/d1 − n2/d2 ≥ pNum/pDen con BigInt exacto (d1, d2, pDen > 0). Para umbrales en puntos porcentuales sin redondear antes. */
export function difFraccionesGE(n1: number, d1: number, n2: number, d2: number, pNum: number, pDen: number): boolean {
  const l = (BigInt(n1) * BigInt(d2) - BigInt(n2) * BigInt(d1)) * BigInt(pDen);
  const r = BigInt(pNum) * BigInt(d1) * BigInt(d2);
  return l >= r;
}

/** 123450 -> "$1,234.50"; negativo: "-$1,234.50". Un valor no entero (o NaN) no es centavos: devuelve «—» en vez de inventar texto. */
export function formatoCentavos(centavos: number): string {
  if (!Number.isSafeInteger(centavos)) return "—";
  const neg = centavos < 0;
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100);
  const cent = abs - pesos * 100;
  return `${neg ? "-" : ""}$${agruparMiles(String(pesos))}.${String(cent).padStart(2, "0")}`;
}

/** 123450 -> "$1,235" (pesos enteros, redondeo de la casa). */
export function formatoPesos(centavos: number): string {
  if (!Number.isSafeInteger(centavos)) return "—";
  const pesos = divEntera(centavos, 100);
  return `${pesos < 0 ? "-" : ""}$${agruparMiles(String(Math.abs(pesos)))}`;
}

/** 1234 -> "1,234". */
export function formatoEntero(n: number): string {
  const neg = n < 0;
  return `${neg ? "-" : ""}${agruparMiles(String(Math.abs(Math.trunc(n))))}`;
}

/** 18.4 -> "18.4 %"; 18 -> "18 %". */
export function formatoPct(p: number): string {
  const s = Number.isInteger(p) ? String(p) : p.toFixed(1);
  return `${s} %`;
}

/** Diferencia en puntos porcentuales: 10 -> "10"; 10.5 -> "10.5". */
export function formatoPuntos(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

/** 41.5 -> "41.5 min"; 40 -> "40 min". */
export function formatoMinutos(m: number): string {
  return `${Number.isInteger(m) ? String(m) : m.toFixed(1)} min`;
}

// ---- Fechas de negocio (YYYY-MM-DD; calendario en UTC, sin zona horaria de por medio) ---------------------------------------------------

export const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Días de `desde` a `hasta`, inclusive. Vacío si hasta < desde. Tope de seguridad: 800 días. */
export function expandirDias(desde: string, hasta: string): string[] {
  if (!fechaNegocioValida(desde) || !fechaNegocioValida(hasta)) throw new RangeError(`rango inválido: ${desde}..${hasta}`);
  const out: string[] = [];
  let d = desde;
  while (d <= hasta) {
    out.push(d);
    if (out.length > 800) throw new RangeError("rango de más de 800 días");
    d = sumarDiasFecha(d, 1);
  }
  return out;
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) + 1;
}

/** "2026-02-17" -> "2026-02". */
export function mesDe(fecha: string): string {
  return fecha.slice(0, 7);
}

/** "2026-02" -> 28. */
export function diasDelMes(mes: string): number {
  const [a, m] = mes.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

/** Lunes (ISO) de la semana de `fecha`. */
export function lunesDe(fecha: string): string {
  return sumarDiasFecha(fecha, 1 - diaSemanaIso(fecha));
}

export function primerDiaDelMes(mes: string): string {
  return `${mes}-01`;
}

export function ultimoDiaDelMes(mes: string): string {
  return `${mes}-${String(diasDelMes(mes)).padStart(2, "0")}`;
}

const DIAS_PLURAL = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábados", "domingos"] as const;

/** Nombre del día en plural para frases como «promedio de los martes». 1 = lunes … 7 = domingo. */
export function nombreDiaPlural(isoDow: number): string {
  return DIAS_PLURAL[isoDow - 1] ?? "días";
}

/** Fecha local YYYY-MM-DD de un instante en una zona IANA (sin `toLocale*`; reloj inyectado). Zona inválida: America/Mexico_City. */
export function fechaLocal(ahora: Date, zonaHoraria: string | null): string {
  for (const zona of [zonaHoraria, "America/Mexico_City"]) {
    if (!zona) continue;
    try {
      const s = new Intl.DateTimeFormat("en-CA", { timeZone: zona, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
      if (FECHA_RE.test(s)) return s;
    } catch {
      // zona inválida: se prueba la siguiente
    }
  }
  return ahora.toISOString().slice(0, 10);
}
