// ═══════════════════════════════════════════════════════════════════════════
// MOTOR ISR DE NÓMINA — puerto de
// ~/Desktop/supabase/despachos/b2b_ai/features/compliance.py::calculate_isr.
// Puro, sin I/O. Verificado campo por campo contra el intérprete Python real
// — ver tests/fixtures/golden_gen_nomina.py y tests/nomina-isr.golden.spec.ts.
//
// ALGORITMO DISTINTO al de declaraciones/isr-engine.ts (Fase 2) — a propósito,
// no por descuido (diseño Fase 3 §2, hallazgo confirmado leyendo ambos
// Pythons):
//
//   declaraciones/isr-engine.ts (`_apply_isr_table` de declaraciones/engine.py):
//     clasifica con `lower <= x < nextLower` — el límite inferior de la fila
//     SIGUIENTE, nunca el `upper` propio de la fila.
//
//   ESTE motor (`calculate_isr` de compliance.py, usado por nómina):
//     clasifica con `lower <= x <= upper` — el `upper` PROPIO de cada fila,
//     leído directamente de la tabla.
//
// Hoy `upper[i] == lower[i+1] - 0.01` en ambas tablas, así que en aritmética
// decimal exacta ambos algoritmos dan el mismo resultado. La diferencia deja
// de ser cosmética en el momento en que `x` no es un literal decimal limpio
// sino el resultado de una suma de floats (p. ej. `salario_diario*30 +
// benefits`, tal como arma `calculate_taxes` antes de llamar aquí): con ESTE
// algoritmo, un valor reconstruido que caiga entre `upper[i]` y `lower[i+1]`
// por un error de representación binaria de ~1e-13 NO clasifica en NINGÚN
// tramo — el for-loop termina sin `break` y la función retorna 0 en silencio.
// Esto es un bug de precisión de punto flotante real y reproducible del
// Python de referencia (NO una interpretación legal a propósito, a diferencia
// del "defecto de 96 horas" de Fase 1) — ver diseño Fase 3 §5.1.
//
// DECISIÓN DE PUERTO (tomada aquí, no delegada, por instrucción explícita de
// la tarea de "construir siguiendo el diseño" y del criterio de fidelidad
// estricta ya aplicado en Fase 1/2 — nunca "corregir" silenciosamente el
// comportamiento observado del Python de referencia): se replica el algoritmo
// EXACTO de `calculate_isr`, hueco incluido. El golden-set
// (tests/fixtures/golden-nomina-output.json, casos `*_hole_denom*`,
// verificados empíricamente contra el intérprete real — no solo los que el
// diseño anticipó) documenta el comportamiento exacto: 3 huecos reproducibles
// confirmados (mensual tramo 0, anual tramos 3 y 8, cada uno vía una
// reconstrucción distinta de `upper/denom*denom`). Si en el futuro se decide
// normalizar la entrada a centavos antes de clasificar (opción (b) del diseño
// §5.1: `Math.round(x*100)/100`), es una corrección de producto explícita y
// documentada aparte — no algo que este port decida por su cuenta.
import { ISR_NOMINA_MENSUAL_2026, ISR_NOMINA_ANUAL_2026, type TablaIsr } from "./isr-nomina-tablas.ts";
import { r2 } from "./redondeo.ts";

/** Puerto exacto de `calculate_isr` (compliance.py). Clasifica con el `upper`
 * PROPIO de cada fila (`lower <= x <= upper`), no con el `lower` de la fila
 * siguiente — ver nota de fidelidad arriba. `baseGravable <= 0` devuelve 0 sin
 * tocar la tabla, igual que el Python (`if taxable_income <= 0: return 0.0`).
 * Si `x` no clasifica en ningún tramo (el hueco de punto flotante, o
 * cualquier entrada fuera de rango que el Python tampoco cubre), retorna 0 —
 * réplica fiel del `return 0.0` final del for-loop de Python, sin excepción
 * ni warning. */
export function calcularIsrNomina(baseGravable: number, annual = false, tabla?: TablaIsr): number {
  const t = tabla ?? (annual ? ISR_NOMINA_ANUAL_2026 : ISR_NOMINA_MENSUAL_2026);
  if (baseGravable <= 0) return 0;

  for (const [lower, upper, fixed, rate] of t) {
    if (lower <= baseGravable && baseGravable <= upper) {
      const excess = baseGravable - lower;
      return r2(fixed + excess * rate);
    }
  }
  return 0;
}
