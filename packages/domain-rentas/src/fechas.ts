// Aritmética de fechas de calendario — REIMPLEMENTADO sobre `Date.UTC` puro, sin
// `@js-temporal/polyfill` (corrección de diseño Fase 1 §1-#8: domain-hoteles ya sentó
// el precedente de no introducir dependencias nuevas al monorepo). Los 3 flujos
// elegidos de rentas solo necesitan aritmética de fechas de calendario (`YYYY-MM-DD`
// como string, diff de días) — ninguno convierte una hora de pared a través de una
// zona horaria (eso solo lo usa iCal sync, Fase 2), así que `Date.UTC` es
// DST-safe por construcción para este alcance: cada `FechaLocal` se ancla a
// medianoche UTC y nunca se le suma/resta una duración horaria, solo días enteros.
import type { FechaLocal, RangoFechas } from "./tipos.ts";

const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/** Convierte una `FechaLocal` a un entero de "días desde la época" (medianoche UTC),
 * validando que sea una fecha de calendario real (rechaza "2024-02-30", por ejemplo,
 * en vez de dejar que `Date` la normalice en silencio al 1 de marzo). */
function aDiasEpoca(fecha: FechaLocal): number {
  const match = FECHA_RE.exec(fecha);
  if (!match) throw new Error(`Fecha inválida (formato esperado YYYY-MM-DD): "${fecha}"`);
  const anio = Number(match[1]);
  const mes = Number(match[2]);
  const dia = Number(match[3]);
  const ms = Date.UTC(anio, mes - 1, dia);
  const verificacion = new Date(ms);
  if (verificacion.getUTCFullYear() !== anio || verificacion.getUTCMonth() !== mes - 1 || verificacion.getUTCDate() !== dia) {
    throw new Error(`Fecha de calendario inválida (no existe): "${fecha}"`);
  }
  return ms / MS_POR_DIA;
}

function desdeDiasEpoca(dias: number): FechaLocal {
  const dt = new Date(dias * MS_POR_DIA);
  const anio = String(dt.getUTCFullYear()).padStart(4, "0");
  const mes = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dia = String(dt.getUTCDate()).padStart(2, "0");
  return `${anio}-${mes}-${dia}`;
}

/** Un rango `[inicio, fin)` es válido si `fin` es estrictamente posterior a `inicio`
 * (nunca vacío, nunca invertido). */
export function esRangoValido(rango: RangoFechas): boolean {
  try {
    return aDiasEpoca(rango.inicio) < aDiasEpoca(rango.fin);
  } catch {
    return false;
  }
}

/** Número de noches de un rango `[inicio, fin)` — equivalente a `fin - inicio` en
 * días de calendario. */
export function calcularNoches(rango: RangoFechas): number {
  if (!esRangoValido(rango)) {
    throw new Error(`Rango inválido: [${rango.inicio}, ${rango.fin})`);
  }
  return aDiasEpoca(rango.fin) - aDiasEpoca(rango.inicio);
}

/** Lista de noches (una por cada fecha de calendario) cubiertas por el rango
 * `[inicio, fin)`, sin incluir `fin` (frontera exclusiva). */
export function nochesDelRango(rango: RangoFechas): FechaLocal[] {
  const noches: FechaLocal[] = [];
  const fin = aDiasEpoca(rango.fin);
  let cursor = aDiasEpoca(rango.inicio);
  while (cursor < fin) {
    noches.push(desdeDiasEpoca(cursor));
    cursor += 1;
  }
  return noches;
}

/** `true` si `noche` está cubierta por `[rango.inicio, rango.fin)`. */
export function rangoCubreNoche(rango: RangoFechas, noche: FechaLocal): boolean {
  const n = aDiasEpoca(noche);
  return aDiasEpoca(rango.inicio) <= n && n < aDiasEpoca(rango.fin);
}

/** Dos rangos semiabiertos se solapan si y solo si cada uno empieza antes de que el
 * otro termine — la definición estándar de intersección de intervalos
 * `[a,b) ∩ [c,d) ≠ ∅ ⟺ a < d ∧ c < b`. Estancias contiguas (checkout de A =
 * check-in de B) dan `false` aquí, igual que el `&&` de `daterange` en Postgres. */
export function rangosSeSuperponen(a: RangoFechas, b: RangoFechas): boolean {
  return aDiasEpoca(a.inicio) < aDiasEpoca(b.fin) && aDiasEpoca(b.inicio) < aDiasEpoca(a.fin);
}

/** Día de la semana (0=domingo..6=sábado, convención `EXTRACT(dow from ...)` de
 * Postgres) de una `FechaLocal`, calculado en UTC — consistente con el resto de este
 * archivo (nunca depende de la zona horaria del proceso Node que ejecuta el código). */
export function diaDeLaSemana(fecha: FechaLocal): number {
  return new Date(aDiasEpoca(fecha) * MS_POR_DIA).getUTCDay();
}

/** Suma (o resta, con `dias` negativo) un número entero de días de calendario a una
 * `FechaLocal` — usado por `./limpieza/buffer.ts` para calcular `checkout + n noches`
 * sin introducir ninguna dependencia nueva (mismo `Date.UTC` DST-safe de arriba). */
export function sumarDias(fecha: FechaLocal, dias: number): FechaLocal {
  return desdeDiasEpoca(aDiasEpoca(fecha) + dias);
}
