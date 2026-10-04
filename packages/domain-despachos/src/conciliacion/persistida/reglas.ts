// D-35 -- reglas puras de la conciliación persistida: el SERVIDOR recalcula con el motor (niveles 1-3) las propuestas de una sesión y
// solo deja confirmar pares que el motor propuso o que una persona con rol de escritura marcó como manuales. Nunca confía en nivel,
// confianza ni origen que mande el cliente.
import { conciliarMovimientos } from "../matching-engine.ts";
import type { CoincidenciaConciliacion, MotivoSinConciliar, OpcionesMatchingEngine, RegistroConciliable } from "../types.ts";
import { ParNoPropuestoPorMotorError } from "./types.ts";
import type { MovimientoGuardado, ParConfirmar } from "./types.ts";

export interface PropuestaMotor {
  readonly movimientoId: string;
  readonly invoiceId: string;
  /** 1 exacto, 2 fuzzy. */
  readonly nivel: 1 | 2;
  readonly confianza: number;
  readonly detalle: string;
  /** D-P3-11: el CFDI tiene dirección `indeterminado`: solo se confirma con revisión humana explícita y nunca se autoconfirma. */
  readonly requiereRevision: boolean;
}

/** Un pago que cubre varios CFDI (nivel 3) con UNA sola combinación posible: se muestra pero NO se confirma por la ruta (un movimiento = un
 * match vigente; el multi-línea confirmable llega con la tabla de grupos, D-07). */
export interface PropuestaMultiLinea {
  readonly movimientoId: string;
  readonly invoiceIds: readonly string[];
  readonly confianza: number;
  readonly detalle: string;
  readonly requiereRevision: boolean;
}

/** D-P3-10: 2 o más combinaciones de CFDI suman el movimiento. La UI muestra «ambiguo: elige una de N combinaciones»; nunca se confirma sin elegir. */
export interface PropuestaAmbigua {
  readonly movimientoId: string;
  readonly combinaciones: readonly (readonly string[])[];
  readonly truncado: boolean;
  readonly exactas: boolean;
}

/** D-P3-10: movimiento sin conciliar, con el motivo y los CFDI individuales más cercanos en monto. */
export interface SinConciliarInfo {
  readonly movimientoId: string;
  readonly motivo: MotivoSinConciliar;
  readonly cercanos: readonly { readonly invoiceId: string; readonly diferenciaCentavos: number }[];
}

export interface ResultadoPropuestas {
  readonly propuestas: readonly PropuestaMotor[];
  readonly multiLinea: readonly PropuestaMultiLinea[];
  readonly ambiguas: readonly PropuestaAmbigua[];
  readonly sinConciliar: readonly SinConciliarInfo[];
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
  const idDe = (i: number): string | undefined => registros[i]?.id;
  for (const c of resultado.matched as readonly CoincidenciaConciliacion[]) {
    const mov = movimientos[c.movementIdx];
    if (!mov) continue;
    if (c.level === "multi_linea" && c.registroIndices) {
      const ids = c.registroIndices.map((i) => registros[i]?.id).filter((id): id is string => typeof id === "string");
      multiLinea.push({ movimientoId: mov.id, invoiceIds: ids, confianza: c.score, detalle: c.detail, requiereRevision: c.requiereRevision === true });
      continue;
    }
    if ((c.level === "exacto" || c.level === "fuzzy") && c.registroIdx !== null) {
      const reg = registros[c.registroIdx];
      if (!reg) continue;
      propuestas.push({ movimientoId: mov.id, invoiceId: reg.id, nivel: c.level === "exacto" ? 1 : 2, confianza: c.score, detalle: c.detail, requiereRevision: c.requiereRevision === true });
    }
  }
  const ambiguas: PropuestaAmbigua[] = [];
  for (const a of resultado.ambiguos) {
    const mov = movimientos[a.movementIdx];
    if (!mov) continue;
    ambiguas.push({
      movimientoId: mov.id,
      combinaciones: a.combinaciones.map((comb) => comb.map(idDe).filter((id): id is string => typeof id === "string")),
      truncado: a.truncado,
      exactas: a.exactas,
    });
  }
  const sinConciliar: SinConciliarInfo[] = [];
  for (const sc of resultado.sinConciliar) {
    const mov = movimientos[sc.movementIdx];
    if (!mov) continue;
    sinConciliar.push({
      movimientoId: mov.id,
      motivo: sc.motivo,
      cercanos: sc.cercanos.flatMap((c) => {
        const id = idDe(c.registroIdx);
        return id === undefined ? [] : [{ invoiceId: id, diferenciaCentavos: c.diferenciaCentavos }];
      }),
    });
  }
  return {
    propuestas,
    multiLinea,
    ambiguas,
    sinConciliar,
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
