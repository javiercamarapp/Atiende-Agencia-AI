// paridad3 D-P3-15 -- cierre mensual en piloto automatico. Funciones PURAS: reciben el estado de los modulos que el SERVIDOR calculo desde datos
// persistidos (`despachos.cierre_estado_modulos`, migracion 027) y devuelven (a) las validaciones que bloquean el cierre y (b) el `moduleState`
// con que se auto-completan las tareas del checklist. El navegador ya NO manda el estado de los modulos (antes `auto-check` confiaba en el body).
//
// Reglas de los umbrales (puerto de `b2b_ai/features/close_management/close_manager.py::finalize`, solo las que se pueden derivar de datos
// persistidos): balanza con tolerancia de $1, polizas con tolerancia de $0.01, bancos conciliados >= 80 %. Las validaciones de IVA, ISR y nomina
// del suelto necesitan insumos que hoy no se persisten por periodo y quedan como hueco declarado (ver el PR); un admin puede forzar el cierre.
import { validateBalanceCuadrada, validateBancosConciliados } from "./validaciones.ts";

export interface EstadoModulosCierre {
  readonly debeCentavos: number;
  readonly haberCentavos: number;
  readonly polizas: number;
  readonly polizasDescuadradas: number;
  /** CFDI de ingreso/egreso del periodo no cancelados. */
  readonly cfdiTotal: number;
  readonly cfdiSinPoliza: number;
  readonly cfdiInvalidos: number;
  readonly conciliacionSesiones: number;
  readonly conciliacionAbiertas: number;
  readonly movimientos: number;
  readonly movimientosConciliados: number;
  readonly pagosProvisionales: number;
  /** `null` = no se pidieron documentos para el periodo (no se evalua). */
  readonly solicitudEstado: "abierta" | "completa" | null;
  readonly solicitudPendientes: number;
  readonly periodicidad: "mensual" | "bimestral" | null;
}

export type ClaveValidacionCierre = "balanza" | "polizas" | "cfdi_sin_poliza" | "conciliacion" | "pagos_provisionales" | "solicitud_documentos";

export interface ValidacionCierre {
  readonly clave: ClaveValidacionCierre;
  readonly titulo: string;
  readonly ok: boolean;
  /** Hoy todas bloquean el cierre; el campo existe para poder degradar una a aviso sin cambiar el contrato. */
  readonly bloqueante: boolean;
  readonly mensaje: string;
  readonly detalle: Readonly<Record<string, number | string | boolean | null>>;
}

export const UMBRAL_CONCILIACION_BANCARIA = 0.8;
export const TOLERANCIA_BALANZA_PESOS = 1;

function pesos(centavos: number): string {
  // Formato es-MX sin toLocale (guard PL-19): separador de miles "," y decimal ".".
  const abs = Math.abs(Math.round(centavos));
  const entero = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${centavos < 0 ? "-" : ""}${entero}.${(abs % 100).toString().padStart(2, "0")}`;
}

/** El papel de pagos provisionales del mes solo aplica a clientes mensuales; un cliente bimestral lo genera en los meses pares. */
export function requierePagosProvisionales(periodicidad: EstadoModulosCierre["periodicidad"], mes: number): boolean {
  return !(periodicidad === "bimestral" && mes % 2 === 1);
}

export function evaluarValidacionesCierre(e: EstadoModulosCierre, mes: number): readonly ValidacionCierre[] {
  const balanza = validateBalanceCuadrada(e.debeCentavos / 100, e.haberCentavos / 100, TOLERANCIA_BALANZA_PESOS);
  const resultado: ValidacionCierre[] = [];

  resultado.push({
    clave: "balanza",
    titulo: "Balanza cuadrada",
    ok: balanza.passed,
    bloqueante: true,
    mensaje: balanza.passed ? "La balanza del libro cuadra." : `La balanza del libro no cuadra: diferencia de $${pesos(Math.abs(e.debeCentavos - e.haberCentavos))} (tolerancia $${TOLERANCIA_BALANZA_PESOS.toFixed(2)}).`,
    detalle: { debeCentavos: e.debeCentavos, haberCentavos: e.haberCentavos, diferenciaCentavos: Math.abs(e.debeCentavos - e.haberCentavos) },
  });

  resultado.push({
    clave: "polizas",
    titulo: "Pólizas cuadradas",
    ok: e.polizasDescuadradas === 0,
    bloqueante: true,
    mensaje: e.polizasDescuadradas === 0 ? `${e.polizas} pólizas del periodo, todas cuadradas.` : `${e.polizasDescuadradas} de ${e.polizas} pólizas del periodo no cuadran. Revísalas en el libro.`,
    detalle: { polizas: e.polizas, descuadradas: e.polizasDescuadradas },
  });

  resultado.push({
    clave: "cfdi_sin_poliza",
    titulo: "CFDI contabilizados",
    ok: e.cfdiSinPoliza === 0,
    bloqueante: true,
    mensaje: e.cfdiSinPoliza === 0 ? "Todos los CFDI de ingreso y egreso del periodo tienen póliza." : `${e.cfdiSinPoliza} de ${e.cfdiTotal} CFDI de ingreso o egreso del periodo no tienen póliza. Genera sus pólizas o regístralas a mano.`,
    detalle: { cfdiTotal: e.cfdiTotal, sinPoliza: e.cfdiSinPoliza },
  });

  let conciliacionOk: boolean;
  let conciliacionMensaje: string;
  if (e.movimientos === 0) {
    conciliacionOk = true;
    conciliacionMensaje = "Sin movimientos bancarios importados en el periodo: no hay nada que conciliar.";
  } else {
    const tasa = e.movimientosConciliados / e.movimientos;
    const bancos = validateBancosConciliados(tasa, UMBRAL_CONCILIACION_BANCARIA, e.movimientos, e.movimientosConciliados);
    const sesionesCerradas = e.conciliacionSesiones > 0 && e.conciliacionAbiertas === 0;
    conciliacionOk = bancos.passed && sesionesCerradas;
    if (conciliacionOk) conciliacionMensaje = `${bancos.message}; sesiones de conciliación cerradas.`;
    else if (!bancos.passed) conciliacionMensaje = `${bancos.message}.`;
    else if (e.conciliacionSesiones === 0) conciliacionMensaje = "No hay una sesión de conciliación bancaria para el periodo.";
    else conciliacionMensaje = `${e.conciliacionAbiertas} sesión(es) de conciliación siguen abiertas: ciérralas para cerrar el periodo.`;
  }
  resultado.push({
    clave: "conciliacion",
    titulo: "Conciliación bancaria",
    ok: conciliacionOk,
    bloqueante: true,
    mensaje: conciliacionMensaje,
    detalle: { movimientos: e.movimientos, conciliados: e.movimientosConciliados, sesiones: e.conciliacionSesiones, sesionesAbiertas: e.conciliacionAbiertas, umbral: UMBRAL_CONCILIACION_BANCARIA },
  });

  const requierePapel = requierePagosProvisionales(e.periodicidad, mes);
  resultado.push({
    clave: "pagos_provisionales",
    titulo: "Papel de pagos provisionales",
    ok: !requierePapel || e.pagosProvisionales > 0,
    bloqueante: true,
    mensaje: !requierePapel ? "El cliente es bimestral: este mes no genera papel de pagos provisionales." : e.pagosProvisionales > 0 ? "El papel de pagos provisionales del periodo está generado." : "Falta generar el papel de pagos provisionales del periodo.",
    detalle: { papeles: e.pagosProvisionales, requerido: requierePapel },
  });

  resultado.push({
    clave: "solicitud_documentos",
    titulo: "Documentos del cliente completos",
    ok: e.solicitudEstado === null || e.solicitudEstado === "completa",
    bloqueante: true,
    mensaje:
      e.solicitudEstado === null
        ? "No se pidieron documentos al cliente para este periodo: no se evalúa."
        : e.solicitudEstado === "completa"
          ? "El cliente entregó (o se marcó como no aplica) todo lo que se le pidió."
          : `Faltan ${e.solicitudPendientes} documento(s) del cliente por recibir o revisar.`,
    detalle: { estado: e.solicitudEstado, pendientes: e.solicitudPendientes },
  });

  return resultado;
}

export function validacionesFallidas(validaciones: readonly ValidacionCierre[]): readonly ValidacionCierre[] {
  return validaciones.filter((v) => v.bloqueante && !v.ok);
}

/**
 * `moduleState` para `autoCheckTareas`, SIEMPRE calculado en el servidor. Solo trae claves de las que hay una senal persistida:
 *  - cfdi_pending_count     -> CFDI de ingreso/egreso del periodo sin poliza.
 *  - cfdi_validacion        -> ningun CFDI del periodo quedo marcado como invalido.
 *  - bank_feeds_sync_status -> la conciliacion bancaria cumple (sesiones cerradas y >= 80 %).
 *  - declaraciones_revisadas -> el papel de pagos provisionales del periodo esta generado (la revision del contador sigue en su tarea manual final).
 * Las demas tareas con auto-check (nomina, DIOT, contabilidad electronica, auxiliares, reportes) no tienen senal persistida: quedan manuales.
 */
export function moduleStateDesdeEstado(e: EstadoModulosCierre, mes: number): Readonly<Record<string, unknown>> {
  const validaciones = evaluarValidacionesCierre(e, mes);
  const conciliacion = validaciones.find((v) => v.clave === "conciliacion")!;
  const pagos = validaciones.find((v) => v.clave === "pagos_provisionales")!;
  return {
    cfdi_pending_count: e.cfdiSinPoliza,
    cfdi_validacion: e.cfdiInvalidos === 0,
    bank_feeds_sync_status: conciliacion.ok ? "ok" : "pendiente",
    declaraciones_revisadas: pagos.ok && e.pagosProvisionales > 0,
  };
}

/** Auto-check hasta punto fijo: una tarea que se completa puede desbloquear a otra que ya estaba antes en la lista. */
export function autoCheckHastaPuntoFijo<T extends { readonly id: string }>(
  tareas: readonly T[],
  aplicar: (actuales: readonly T[]) => { readonly tareas: readonly T[]; readonly completadas: readonly T[] },
  maxVueltas = 10,
): { readonly tareas: readonly T[]; readonly completadas: readonly T[] } {
  let actuales = tareas;
  const completadas: T[] = [];
  for (let i = 0; i < maxVueltas; i++) {
    const r = aplicar(actuales);
    if (r.completadas.length === 0) break;
    completadas.push(...r.completadas);
    actuales = r.tareas;
  }
  return { tareas: actuales, completadas };
}
