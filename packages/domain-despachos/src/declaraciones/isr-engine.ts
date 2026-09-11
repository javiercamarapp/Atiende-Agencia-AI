// ═══════════════════════════════════════════════════════════════════════════
// MOTOR ISR — puerto de
// ~/Desktop/supabase/despachos/b2b_ai/features/declaraciones/engine.py
// (_apply_isr_table, calculate_isr_pf, calculate_isr_pm, calculate_isr_pm_resico).
// Puro, sin I/O, sin fechas de sistema — mismo criterio que vencimientos/engine.ts.
//
// Verificado campo por campo contra el intérprete Python real — ver
// tests/fixtures/golden_gen_declaraciones.py y
// tests/declaraciones-isr.golden.spec.ts. Tres detalles NO obvios que un port
// ingenuo rompe (diseño Fase 2 §2.1), replicados aquí a propósito:
//
//   1. La clasificación de tramo usa el límite inferior de la fila SIGUIENTE
//      (`table[i+1][0]`), NUNCA el `limiteSuperior` propio de la fila (salvo el
//      último renglón, donde no hay fila siguiente). Hoy `limiteSuperior[i] ==
//      limiteInferior[i+1] - 0.01` en todas las tablas, así que un port que usara
//      `income <= limiteSuperior` daría el mismo resultado HOY — pero dejaría de ser
//      el mismo algoritmo, y un futuro cambio de tabla (huecos, redondeos distintos)
//      lo rompería en silencio. Aquí se clasifica exactamente como el original.
//   2. El "excedente" se calcula sobre el `limiteInferior` DE LA TABLA, no sobre un
//      valor derivado — es la aplicación correcta de tarifa progresiva (Art. 96
//      LISR: cuota fija + tasa sobre el excedente del límite inferior).
//   3. `baseGravable <= 0` devuelve 0 sin tocar la tabla (ingresos negativos nunca
//      producen ISR negativo).
//
// Las tres funciones reciben la tabla (o parámetros equivalentes) explícitos con un
// default documentado — nunca una constante de módulo importada ciegamente una sola
// vez, a diferencia de cómo `engine.py`/`service.py` importan `ISR_MENSUAL_2025` por
// nombre fijo sin pasar por `get_isr_table(FISCAL_YEAR)` (ver isr-tablas.ts, NOTA DE
// FIDELIDAD, y diseño Fase 2 §1).
import { ISR_PF_ANUAL_2025, ISR_PF_MENSUAL_2025, ISR_PM_MENSUAL_RESICO, ISR_PM_TASA, type TablaIsr } from "./isr-tablas.ts";
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
  /** Tabla explícita a usar — default documentado: ISR_PF_MENSUAL_2025/ISR_PF_ANUAL_2025
   * (fidelidad al comportamiento real de `engine.py` hoy, ver isr-tablas.ts). Nunca se
   * selecciona por año fiscal de forma implícita: pasar la tabla es la única manera de
   * cambiar de año, para que sea una decisión consciente (diseño §1). */
  readonly tabla?: TablaIsr;
}

/** Puerto de `calculate_isr_pf` — LISR Art. 96 / Art. 152. */
export function calcularIsrPf(baseGravable: number, opts: OpcionesIsrPf = {}): IsrResultado {
  const annual = opts.annual ?? false;
  const pagosProvisionales = opts.pagosProvisionales ?? 0;
  const tabla = opts.tabla ?? (annual ? ISR_PF_ANUAL_2025 : ISR_PF_MENSUAL_2025);

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

/** Puerto de `calculate_isr_pm` — LISR Art. 9: ISR PM = utilidad_fiscal × 30%. */
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

/** Puerto de `calculate_isr_pm_resico` — LISR Art. 206, 209 (RESICO PM), tabla mensual
 * progresiva sobre ingreso acumulable. */
export function calcularIsrPmResico(ingresoMensual: number, pagosProvisionales = 0, tabla: TablaIsr = ISR_PM_MENSUAL_RESICO): IsrResultado {
  const ingreso = Math.max(0, ingresoMensual);
  const isrBruto = aplicarTablaIsr(ingreso, tabla);
  const isrNeto = r2(Math.max(0, isrBruto - pagosProvisionales));
  const tasaEfectiva = ingreso > 0 ? r4(isrBruto / ingreso) : 0;

  return {
    baseGravable: ingreso,
    isrBruto,
    tasaEfectiva,
    tipoContribuyente: "PM",
    tablaAplicada: "pm_resico",
    isrNeto,
    pagosProvisionales,
  };
}
