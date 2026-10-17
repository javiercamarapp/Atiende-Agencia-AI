// D-P3-10 -- forma de las propuestas del motor que se GUARDAN en la sesión (migración 025, `conciliacion_sesion.propuestas`): se calculan al crear
// o refrescar la sesión (y con `POST .../recalcular`) y el GET las lee, en vez de correr el motor en cada lectura.
import type { PropuestaAmbigua, PropuestaMotor, PropuestaMultiLinea, SinConciliarInfo } from "./reglas.ts";

export interface PropuestasGuardadas {
  readonly version: 1;
  readonly calculadoEn: string;
  readonly propuestas: readonly PropuestaMotor[];
  readonly multiLinea: readonly PropuestaMultiLinea[];
  readonly ambiguas: readonly PropuestaAmbigua[];
  readonly sinConciliar: readonly SinConciliarInfo[];
}

const esObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Valida lo leído de la base (jsonb) antes de usarlo: un valor malformado (versión futura, escritura manual) se descarta, nunca rompe el GET. */
export function leerPropuestasGuardadas(crudo: unknown): PropuestasGuardadas | null {
  if (!esObjeto(crudo) || crudo.version !== 1 || typeof crudo.calculadoEn !== "string") return null;
  const lista = (k: string): unknown[] | null => (Array.isArray(crudo[k]) ? (crudo[k] as unknown[]) : null);
  const propuestas = lista("propuestas");
  const multiLinea = lista("multiLinea");
  const ambiguas = lista("ambiguas");
  const sinConciliar = lista("sinConciliar");
  if (!propuestas || !multiLinea || !ambiguas || !sinConciliar) return null;
  const forma = propuestas.every((p) => esObjeto(p) && typeof p.movimientoId === "string" && typeof p.invoiceId === "string") && multiLinea.every((p) => esObjeto(p) && typeof p.movimientoId === "string" && Array.isArray(p.invoiceIds));
  const forma2 = ambiguas.every((p) => esObjeto(p) && typeof p.movimientoId === "string" && Array.isArray(p.combinaciones)) && sinConciliar.every((p) => esObjeto(p) && typeof p.movimientoId === "string" && Array.isArray(p.cercanos));
  if (!forma || !forma2) return null;
  return crudo as unknown as PropuestasGuardadas;
}

/** Quita de las propuestas guardadas lo que dejó de estar libre desde que se calcularon (movimiento ya conciliado o CFDI ya conciliado). Barato:
 * conjuntos, sin volver a correr el motor. */
export function vigentesDe(g: PropuestasGuardadas, movimientosLibres: ReadonlySet<string>, invoicesLibres: ReadonlySet<string>): PropuestasGuardadas {
  return {
    ...g,
    propuestas: g.propuestas.filter((p) => movimientosLibres.has(p.movimientoId) && invoicesLibres.has(p.invoiceId)),
    multiLinea: g.multiLinea.filter((p) => movimientosLibres.has(p.movimientoId) && p.invoiceIds.every((i) => invoicesLibres.has(i))),
    ambiguas: g.ambiguas
      .filter((p) => movimientosLibres.has(p.movimientoId))
      .map((p) => ({ ...p, combinaciones: p.combinaciones.filter((c) => c.every((i) => invoicesLibres.has(i))) }))
      .filter((p) => p.combinaciones.length >= 2),
    sinConciliar: g.sinConciliar.filter((p) => movimientosLibres.has(p.movimientoId)).map((p) => ({ ...p, cercanos: p.cercanos.filter((c) => invoicesLibres.has(c.invoiceId)) })),
  };
}
