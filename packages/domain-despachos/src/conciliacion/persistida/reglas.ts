// D-35 -- reglas puras de la conciliación persistida: el SERVIDOR recalcula con el motor (niveles 1-3) las propuestas de una sesión y
// solo deja confirmar pares que el motor propuso o que una persona con rol de escritura marcó como manuales. Nunca confía en nivel,
// confianza ni origen que mande el cliente.
import { compatibilidadDireccion, conciliarMovimientos } from "../matching-engine.ts";
import type { CoincidenciaConciliacion, MotivoSinConciliar, OpcionesMatchingEngine, RegistroConciliable } from "../types.ts";
import { fechaDiff } from "../fechas.ts";
import { aCentavos } from "../subset-sum.ts";
import { ConciliacionRevisionRequeridaError, ParNoPropuestoPorMotorError } from "./types.ts";
import type { PropuestasGuardadas } from "./propuestas-guardadas.ts";
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
  /** D-P3-11: la persona revisó un CFDI de dirección indeterminada y lo confirma. Sin esto, un par que requiere revisión se rechaza. */
  readonly revisado?: boolean;
}

/** Traduce lo que pidió el cliente a pares confirmables: un par del motor toma nivel y confianza de la propuesta del SERVIDOR; un par
 * manual no lleva nivel ni confianza. Cualquier otro par lanza `ParNoPropuestoPorMotorError` (la solicitud entera se rechaza). */
export function resolverPares(solicitados: readonly ParSolicitado[], propuestas: readonly PropuestaMotor[]): readonly ParConfirmar[] {
  const porPar = new Map(propuestas.map((p) => [`${p.movimientoId}|${p.invoiceId}`, p]));
  return solicitados.map((s) => {
    if (s.manual) return { movimientoId: s.movimientoId, invoiceId: s.invoiceId, nivel: null, confianza: null, origen: "manual" as const };
    const p = porPar.get(`${s.movimientoId}|${s.invoiceId}`);
    if (!p) throw new ParNoPropuestoPorMotorError(s.movimientoId, s.invoiceId);
    if (p.requiereRevision && s.revisado !== true) throw new ConciliacionRevisionRequeridaError(s.movimientoId, s.invoiceId);
    return { movimientoId: s.movimientoId, invoiceId: s.invoiceId, nivel: p.nivel, confianza: p.confianza, origen: "motor" as const };
  });
}

/** D-P3-10: lo que se guarda en la sesión tras correr el motor. */
export function aPropuestasGuardadas(r: ResultadoPropuestas, calculadoEn: string): PropuestasGuardadas {
  return { version: 1, calculadoEn, propuestas: r.propuestas, multiLinea: r.multiLinea, ambiguas: r.ambiguas, sinConciliar: r.sinConciliar };
}

/** D-P3-10: el servidor nunca confía en el cliente, pero ya no re-ejecuta el motor sobre TODAS las facturas del cliente al confirmar: verifica
 * cada par solicitado ACOTADO AL PAR (el movimiento y el CFDI, leídos del servidor, pasan por el motor solos). Un par manual no lleva
 * nivel ni confianza; un par del motor toma nivel y confianza de ESA verificación. Un par que el motor no propone, aun a solas, se rechaza. */
export function resolverParesAcotados(
  solicitados: readonly ParSolicitado[],
  movimientos: ReadonlyMap<string, MovimientoGuardado>,
  registros: ReadonlyMap<string, RegistroConciliable>,
  opciones: OpcionesMatchingEngine = {},
): readonly ParConfirmar[] {
  return solicitados.map((s) => {
    if (s.manual) return { movimientoId: s.movimientoId, invoiceId: s.invoiceId, nivel: null, confianza: null, origen: "manual" as const };
    const mov = movimientos.get(s.movimientoId);
    const reg = registros.get(s.invoiceId);
    if (!mov || !reg) throw new ParNoPropuestoPorMotorError(s.movimientoId, s.invoiceId);
    const p = calcularPropuestas([mov], [reg], opciones).propuestas.find((x) => x.movimientoId === s.movimientoId && x.invoiceId === s.invoiceId);
    if (!p) throw new ParNoPropuestoPorMotorError(s.movimientoId, s.invoiceId);
    if (p.requiereRevision && s.revisado !== true) throw new ConciliacionRevisionRequeridaError(s.movimientoId, s.invoiceId);
    return { movimientoId: s.movimientoId, invoiceId: s.invoiceId, nivel: p.nivel, confianza: p.confianza, origen: "motor" as const };
  });
}

export interface ParAutoconfirmable {
  readonly movimientoId: string;
  readonly invoiceId: string;
  readonly confianza: number;
}

const DIAS_VENTANA_UNICIDAD = 3;

function montoDe(r: RegistroConciliable): number | null {
  const v = r.monto !== undefined && r.monto !== null ? r.monto : r.total;
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** D-P3-12: de las propuestas del motor, SOLO las que el piloto automático puede confirmar: nivel 1, dirección explícita (nunca `indeterminado` ni sin dato)
 * y ÚNICAS: ningún otro CFDI libre cuadra con el movimiento (monto a 1 centavo, dirección compatible, dentro de la ventana de fechas) ni ningún otro
 * movimiento libre cuadra con el CFDI. Nunca incluye nivel 2, grupos (multi-línea), ambiguos ni sugerencias de IA. */
export function seleccionarAutoconfirmables(
  propuestas: readonly PropuestaMotor[],
  movimientos: readonly MovimientoGuardado[],
  registros: readonly RegistroConciliable[],
  diasVentana = DIAS_VENTANA_UNICIDAD,
): readonly ParAutoconfirmable[] {
  const movPorId = new Map(movimientos.map((m) => [m.id, m]));
  const regPorId = new Map(registros.map((r) => [r.id, r]));
  const cuadra = (m: MovimientoGuardado, r: RegistroConciliable): boolean => {
    const montoRec = montoDe(r);
    if (montoRec === null) return false;
    if (Math.abs(aCentavos(Math.abs(m.monto)) - aCentavos(Math.abs(montoRec))) > 1) return false;
    if (compatibilidadDireccion(m, r) === "incompatible") return false;
    const d = fechaDiff(m.fecha, (r.fecha ?? "").slice(0, 10));
    return d !== null && d <= diasVentana;
  };
  const salida: ParAutoconfirmable[] = [];
  for (const p of propuestas) {
    if (p.nivel !== 1 || p.requiereRevision) continue;
    const m = movPorId.get(p.movimientoId);
    const r = regPorId.get(p.invoiceId);
    if (!m || !r) continue;
    if (r.direccion !== "emitido" && r.direccion !== "recibido") continue;
    if (!cuadra(m, r)) continue;
    const otrosParaElMovimiento = registros.some((x) => x.id !== r.id && cuadra(m, x));
    const otrosParaElCfdi = movimientos.some((x) => x.id !== m.id && cuadra(x, r));
    if (otrosParaElMovimiento || otrosParaElCfdi) continue;
    salida.push({ movimientoId: m.id, invoiceId: r.id, confianza: p.confianza });
  }
  return salida;
}
