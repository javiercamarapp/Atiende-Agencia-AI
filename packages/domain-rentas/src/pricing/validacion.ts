// Validaciones de escritura de pricing (Fase 2, Flujo 4) — cierran una brecha real del
// repo origen, no una regla que ya existiera ahí (ver diseño Fase 2 rentas §3.2/§3.4):
// el origen NUNCA comprueba que dos temporadas/reglas min-stay de la misma unidad se
// traslapen, y `cotizacion.ts::calcularCotizacion` resuelve el precio de una noche con
// el PRIMER match del arreglo — sin este chequeo, dos temporadas traslapadas producen
// un precio no determinista para el huésped (depende del orden en que Postgres
// devuelva las filas). Funciones puras: solo deciden SI hay conflicto, nunca persisten
// nada.
import { rangosSeSuperponen } from "../fechas.ts";
import type { RangoFechas } from "../tipos.ts";

export interface TemporadaExistente {
  readonly id: string;
  readonly nombre: string;
  readonly rango: RangoFechas;
}

/** Primera temporada existente (de la misma unidad) cuyo rango se traslapa con
 * `nuevoRango`, o `null` si ninguna lo hace. Dos temporadas de una unidad NUNCA pueden
 * traslaparse, sin excepción (a diferencia de min-stay, aquí no hay una dimensión
 * adicional — día de semana — que las haga compatibles). */
export function encontrarTemporadaSolapada(existentes: readonly TemporadaExistente[], nuevoRango: RangoFechas, excluirId?: string): TemporadaExistente | null {
  return existentes.find((t) => t.id !== excluirId && rangosSeSuperponen(t.rango, nuevoRango)) ?? null;
}

export interface ReglaMinStayExistente {
  readonly id: string;
  readonly rango: RangoFechas;
  readonly diaSemanaCheckIn: number | null;
}

/**
 * Primera regla de min-stay existente que conflictúa con la nueva, o `null`. A
 * diferencia de temporadas, dos reglas de min-stay pueden solaparse EN RANGO sin ser un
 * conflicto real si aplican a un día de semana distinto (una para todos los días, otra
 * solo sábado) — `evaluarViolacionesMinStay` (pricing/cotizacion.ts) ya las evalúa de
 * forma independiente. Solo es conflicto cuando, además de solaparse en rango, ambas
 * comparten el MISMO `diaSemanaCheckIn` (incluyendo `null` vs `null`, que significa
 * "todos los días" en ambas).
 */
export function encontrarMinStaySolapada(existentes: readonly ReglaMinStayExistente[], nueva: { rango: RangoFechas; diaSemanaCheckIn: number | null }, excluirId?: string): ReglaMinStayExistente | null {
  return existentes.find((r) => r.id !== excluirId && r.diaSemanaCheckIn === nueva.diaSemanaCheckIn && rangosSeSuperponen(r.rango, nueva.rango)) ?? null;
}
