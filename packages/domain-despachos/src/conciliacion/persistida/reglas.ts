// D-35 -- reglas puras de la conciliación persistida: el SERVIDOR recalcula con el motor (niveles 1-3) las propuestas de una sesión y
// solo deja confirmar pares que el motor propuso o que una persona con rol de escritura marcó como manuales. Nunca confía en nivel,
// confianza ni origen que mande el cliente.
import { conciliarMovimientos } from "../matching-engine.ts";
import type { CoincidenciaConciliacion, OpcionesMatchingEngine, RegistroConciliable } from "../types.ts";
import { ParNoPropuestoPorMotorError } from "./types.ts";
import type { MovimientoGuardado, ParConfirmar } from "./types.ts";

export interface PropuestaMotor {
  readonly movimientoId: string;
  readonly invoiceId: string;
  /** 1 exacto, 2 fuzzy. */
  readonly nivel: 1 | 2;
  readonly confianza: number;
  readonly detalle: string;
}

/** Un pago que cubre varios CFDI (nivel 3): se muestra pero NO se confirma por la ruta (un movimiento = un match vigente). */
export interface PropuestaMultiLinea {
  readonly movimientoId: string;
  readonly invoiceIds: readonly string[];
  readonly confianza: number;
  readonly detalle: string;
}

export interface ResultadoPropuestas {
  readonly propuestas: readonly PropuestaMotor[];
  readonly multiLinea: readonly PropuestaMultiLinea[];
  /** Movimientos sin propuesta (misma referencia que los pasados al motor). */
  readonly movimientosSinConciliar: readonly MovimientoGuardado[];
  /** CFDI sin propuesta (misma referencia que los pasados al motor). */
  readonly registrosSinConciliar: readonly RegistroConciliable[];
}

/** Corre el motor determinístico sobre los movimientos aún sin match vigente y los CFDI aún sin conciliar. */
export function calcularPropuestas(movimientos: readonly MovimientoGuardado[], registros: readonly RegistroConciliable[], opciones: OpcionesMatchingEngine = {}): ResultadoPropuestas {
  const resultado = conciliarMovimientos(movimientos, registros, opciones);
  const propuestas: PropuestaMotor[] = [];
  const multiLinea: PropuestaMultiLinea[] = [];
  for (const c of resultado.matched as readonly CoincidenciaConciliacion[]) {
    const mov = movimientos[c.movementIdx];
    if (!mov) continue;
    if (c.level === "multi_linea" && c.registroIndices) {
      const ids = c.registroIndices.map((i) => registros[i]?.id).filter((id): id is string => typeof id === "string");
      multiLinea.push({ movimientoId: mov.id, invoiceIds: ids, confianza: c.score, detalle: c.detail });
      continue;
    }
    if ((c.level === "exacto" || c.level === "fuzzy") && c.registroIdx !== null) {
      const reg = registros[c.registroIdx];
      if (!reg) continue;
      propuestas.push({ movimientoId: mov.id, invoiceId: reg.id, nivel: c.level === "exacto" ? 1 : 2, confianza: c.score, detalle: c.detail });
    }
  }
  return {
    propuestas,
    multiLinea,
    movimientosSinConciliar: resultado.unmatchedBank as readonly MovimientoGuardado[],
    registrosSinConciliar: resultado.unmatchedBooks,
  };
}

export interface ParSolicitado {
  readonly movimientoId: string;
  readonly invoiceId: string;
  readonly manual: boolean;
}

/** Traduce lo que pidió el cliente a pares confirmables: un par del motor toma nivel y confianza de la propuesta del SERVIDOR; un par
 * manual no lleva nivel ni confianza. Cualquier otro par lanza `ParNoPropuestoPorMotorError` (la solicitud entera se rechaza). */
export function resolverPares(solicitados: readonly ParSolicitado[], propuestas: readonly PropuestaMotor[]): readonly ParConfirmar[] {
  const porPar = new Map(propuestas.map((p) => [`${p.movimientoId}|${p.invoiceId}`, p]));
  return solicitados.map((s) => {
    if (s.manual) return { movimientoId: s.movimientoId, invoiceId: s.invoiceId, nivel: null, confianza: null, origen: "manual" as const };
    const p = porPar.get(`${s.movimientoId}|${s.invoiceId}`);
    if (!p) throw new ParNoPropuestoPorMotorError(s.movimientoId, s.invoiceId);
    return { movimientoId: s.movimientoId, invoiceId: s.invoiceId, nivel: p.nivel, confianza: p.confianza, origen: "motor" as const };
  });
}
