// ═══════════════════════════════════════════════════════════════════════════
// MOTOR ISR — cálculo de ISR de personas físicas (Art. 96/152 LISR), personas
// morales (Art. 9 LISR) y RESICO personas morales (Art. 206/209 LISR) sobre
// flujo de efectivo. Puro, sin I/O, sin fechas de sistema — mismo criterio
// que vencimientos/engine.ts.
//
// CORRECCIÓN FISCAL (auditoría, hallazgos CRÍTICOS #1 y #2 — severidad legal
// directa, ver isr-tablas.ts para el detalle completo de #1):
//   #1. `calcularIsrPf` defaulteaba a una tarifa 2025 que ni siquiera
//       coincidía con la publicada por el SAT, Y usaba un ejercicio distinto
//       al que defaulteaba `calcularIsrNomina` (nomina/isr-nomina-engine.ts)
//       para la MISMA tarifa legal (Art. 96) — dos motores, dos resultados
//       para la misma base gravable. Ahora ambos defaultean a
//       `ISR_MENSUAL_2026`/`ISR_ANUAL_2026` (el ejercicio vigente a esta
//       corrección), la MISMA fuente (`isr-tablas.ts`).
//   #2. `calcularIsrPmResico` aplicaba la tabla progresiva de RESICO PERSONA
//       FÍSICA (Art. 113-E — hoy `RESICO_PF_MENSUAL` en isr-tablas.ts) a un
//       cálculo que dice ser de RESICO PERSONA MORAL. RESICO PM (Art.
//       206/209 LISR) NO tiene tarifa progresiva: es tasa fija de 30%
//       (`ISR_PM_TASA`, la misma del Art. 9 general) sobre el resultado
//       fiscal determinado con base en FLUJO DE EFECTIVO (ingresos
//       efectivamente cobrados − deducciones autorizadas efectivamente
//       pagadas), nunca sobre el ingreso bruto. Ver la función abajo.
//
// Tres detalles algorítmicos NO relacionados con la corrección de arriba,
// verificados contra el golden-set (tests/declaraciones-isr.golden.spec.ts)
// y preservados sin cambio:
//   1. La clasificación de tramo usa el límite inferior de la fila SIGUIENTE
//      (`table[i+1][0]`), NUNCA el `limiteSuperior` propio de la fila (salvo el
//      último renglón, donde no hay fila siguiente).
//   2. El "excedente" se calcula sobre el `limiteInferior` DE LA TABLA, no sobre un
//      valor derivado — es la aplicación correcta de tarifa progresiva (Art. 96
//      LISR: cuota fija + tasa sobre el excedente del límite inferior).
//   3. `baseGravable <= 0` devuelve 0 sin tocar la tabla (ingresos negativos nunca
//      producen ISR negativo).
//
// Las funciones reciben la tabla/tasa explícita con un default documentado —
// nunca una constante de módulo importada ciegamente sin poder cambiarla por
// llamador (p. ej. para declarar/corregir un periodo de un ejercicio
// anterior con `ISR_MENSUAL_2025`/`ISR_ANUAL_2025`, aún disponibles en
// isr-tablas.ts).
import { ISR_ANUAL_2026, ISR_MENSUAL_2026, ISR_PM_TASA, type TablaIsr } from "./isr-tablas.ts";
import type { IsrResultado } from "./types.ts";

/** Redondeo a 2 decimales. NOTA DE FIDELIDAD: Python `round(x, 2)` usa round-half-to-
 * even (banker's rounding) sobre el float binario más cercano al literal decimal —
 * NO es "redondear hacia arriba desde 0.5". Este helper usa "half away from zero" con
 * corrección de épsilon (mismo criterio que `r2()` de reglas-fiscales-avanzadas.ts).
 * Los 63 casos del golden-set (tests/fixtures/golden-declaraciones-output.json) NO
 * contienen ningún empate exacto en el segundo decimal — verificado al generarlo (ver
 * diseño §5) — así que esta implementación reproduce el Python real en la práctica
 * para todo el rango probado. Si un futuro caso SÍ cae en un empate exacto y este
 * helper no coincide con Python, hay que escribir el redondeo aparte para ese caso —
 * no asumir que este helper sirve sin probarlo contra el intérprete real primero. */
function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Redondeo a 4 decimales, para `tasaEfectiva` (Python `round(x, 4)`). */
function r4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/** Puerto de `_apply_isr_table` — ver notas 1-3 arriba. */
export function aplicarTablaIsr(baseGravable: number, tabla: TablaIsr): number {
  if (baseGravable <= 0) return 0;

  for (let i = 0; i < tabla.length; i++) {
    const [lower, , fixed, rate] = tabla[i]!;
    if (i < tabla.length - 1) {
      const nextLower = tabla[i + 1]![0];
      if (lower <= baseGravable && baseGravable < nextLower) {
        const excess = baseGravable - lower;
        return r2(fixed + excess * rate);
      }
    } else if (baseGravable >= lower) {
      const excess = baseGravable - lower;
      return r2(fixed + excess * rate);
    }
  }
  return 0;
}

export interface OpcionesIsrPf {
  readonly annual?: boolean;
  readonly pagosProvisionales?: number;
  /** Tabla explícita a usar — default documentado: `ISR_MENSUAL_2026`/
   * `ISR_ANUAL_2026` (el ejercicio vigente, ver isr-tablas.ts — MISMO default
   * que usa `calcularIsrNomina` para la misma tarifa Art. 96, corrección del
   * hallazgo CRÍTICO #1). Para declarar/corregir un periodo de un ejercicio
   * anterior, pasa `ISR_MENSUAL_2025`/`ISR_ANUAL_2025` explícitamente. */
  readonly tabla?: TablaIsr;
}

/** ISR de personas físicas — LISR Art. 96 (retenciones/pagos provisionales)
 * / Art. 152 (declaración anual). */
export function calcularIsrPf(baseGravable: number, opts: OpcionesIsrPf = {}): IsrResultado {
  const annual = opts.annual ?? false;
  const pagosProvisionales = opts.pagosProvisionales ?? 0;
  const tabla = opts.tabla ?? (annual ? ISR_ANUAL_2026 : ISR_MENSUAL_2026);

  const isrBruto = aplicarTablaIsr(Math.max(0, baseGravable), tabla);
  const isrNeto = r2(Math.max(0, isrBruto - pagosProvisionales));
  const tasaEfectiva = baseGravable > 0 ? r4(isrBruto / baseGravable) : 0;

  return {
    baseGravable,
    isrBruto,
    tasaEfectiva,
    tipoContribuyente: "PF",
    tablaAplicada: annual ? "annual" : "monthly",
    isrNeto,
    pagosProvisionales,
  };
}

/** ISR de personas morales — LISR Art. 9: ISR PM = utilidad fiscal × 30%. */
export function calcularIsrPm(utilidadFiscal: number, pagosProvisionales = 0, tasa: number = ISR_PM_TASA): IsrResultado {
  const utilidad = Math.max(0, utilidadFiscal);
  const isrBruto = r2(utilidad * tasa);
  const isrNeto = r2(Math.max(0, isrBruto - pagosProvisionales));

  return {
    baseGravable: utilidad,
    isrBruto,
    tasaEfectiva: utilidad > 0 ? tasa : 0,
    tipoContribuyente: "PM",
    tablaAplicada: "pm_30%",
    isrNeto,
    pagosProvisionales,
  };
}

export interface OpcionesIsrPmResico {
  /** Deducciones autorizadas (Art. 208 LISR) EFECTIVAMENTE PAGADAS en el mes —
   * junto con `ingresosCobrados`, determina el flujo de efectivo que es la
   * base gravable real de RESICO PM. Default 0 (si el llamador solo conoce
   * el ingreso bruto, el resultado sobreestima el ISR real — mejor eso que
   * fabricar una deducción que nadie proveyó). */
  readonly deduccionesAutorizadas?: number;
  readonly pagosProvisionales?: number;
  /** Tasa explícita — default `ISR_PM_TASA` (30%, Art. 9/206/209 LISR). RESICO
   * PM nunca aplica una tarifa progresiva (ver corrección del hallazgo
   * CRÍTICO #2 en la cabecera del archivo). */
  readonly tasa?: number;
}

/** ISR de RESICO personas morales — LISR Art. 206/209: tasa FIJA (30%, la
 * misma del Art. 9 general — nunca una tarifa progresiva) sobre el
 * resultado fiscal determinado con FLUJO DE EFECTIVO: ingresos
 * efectivamente cobrados MENOS deducciones autorizadas efectivamente
 * pagadas en el mes (Art. 208 LISR), nunca sobre el ingreso bruto.
 *
 * CORRECCIÓN FISCAL (auditoría, hallazgo CRÍTICO #2): esta función aplicaba
 * antes la tabla progresiva de RESICO PERSONA FÍSICA (Art. 113-E, hoy
 * `RESICO_PF_MENSUAL` en isr-tablas.ts) — un régimen distinto, con una
 * mecánica de cálculo distinta (tasa plana sobre el TOTAL del ingreso del
 * tramo, no cuota-fija-más-excedente) que además nunca aplica a personas
 * morales. RESICO PM no tiene tabla: es 30% plano sobre flujo de efectivo. */
export function calcularIsrPmResico(ingresosCobrados: number, opts: OpcionesIsrPmResico = {}): IsrResultado {
  const deducciones = Math.max(0, opts.deduccionesAutorizadas ?? 0);
  const pagosProvisionales = opts.pagosProvisionales ?? 0;
  const tasa = opts.tasa ?? ISR_PM_TASA;

  const flujoEfectivo = Math.max(0, Math.max(0, ingresosCobrados) - deducciones);
  const isrBruto = r2(flujoEfectivo * tasa);
  const isrNeto = r2(Math.max(0, isrBruto - pagosProvisionales));

  return {
    baseGravable: flujoEfectivo,
    isrBruto,
    tasaEfectiva: flujoEfectivo > 0 ? tasa : 0,
    tipoContribuyente: "PM",
    tablaAplicada: "pm_resico",
    isrNeto,
    pagosProvisionales,
  };
}
