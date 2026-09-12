// ═══════════════════════════════════════════════════════════════════════════
// TABLAS ISR DE NÓMINA — puerto 1:1 de las constantes de
// ~/Desktop/supabase/despachos/b2b_ai/fiscal_tables.py
// (ISR_MENSUAL_2026, ISR_ANUAL_2026), tal como las consume
// b2b_ai/features/compliance.py::calculate_isr — el motor de ISR que
// REALMENTE ejecuta hoy /nomina-completa/* y /nomina/* (ver diseño Fase 3 §1).
// Archivo de SOLO DATOS: ninguna lógica de clasificación de tramo vive aquí
// (eso es isr-nomina-engine.ts). Verificado ejecutando el intérprete Python
// real (ver tests/fixtures/golden_gen_nomina.py + golden-nomina-output.json).
//
// NOTA DE FIDELIDAD 1 (alias engañoso): `compliance.py` importa así:
//     from b2b_ai.fiscal_tables import (
//         ISR_MENSUAL_2026 as ISR_TABLE_2024_MONTHLY,
//         ISR_ANUAL_2026 as ISR_TABLE_2024_ANNUAL,
//     )
// El NOMBRE del alias dice "2024" pero el CONTENIDO importado es la tabla
// 2026. Estas constantes se llaman aquí ISR_NOMINA_*_2026 (el año real), no
// "2024" — nombrarlas como el alias engañoso del Python solo propagaría la
// confusión sin ganar fidelidad (los VALORES son lo que se porta, no el
// nombre de una variable interna de otro módulo).
//
// NOTA DE FIDELIDAD 2 (sin selector por año): `calculate_isr(taxable_income,
// annual=False)` NO recibe un parámetro `year` — a diferencia de
// `declaraciones/engine.py` (que al menos importa una tabla fija por nombre,
// pero fiscal_tables.py sí expone `get_isr_table(year, period)` sin que nadie
// lo use desde nómina), aquí ni siquiera existe la posibilidad estructural de
// pedir otro año: siempre son estas dos tablas, pase lo que pase. isr-nomina-
// engine.ts respeta esto: no hay parámetro `year`, solo `tabla` explícita con
// default documentado (mismo criterio que isr-tablas.ts de declaraciones).
//
// NOTA DE FIDELIDAD 3 (tabla ISR de nómina ≠ tabla ISR de honorarios): esta
// tabla NO es la misma que ISR_PF_MENSUAL_2025/ISR_PF_ANUAL_2025 de
// declaraciones/isr-tablas.ts (Fase 2) — son ejercicios fiscales distintos
// (2026 vs 2025) porque cada motor Python importa una constante fija
// distinta. No unificar ambas tablas: son dos "verdades" independientes en el
// sistema de referencia hoy (ver diseño Fase 3 §1).
//
// Formato de cada fila: [limiteInferior, limiteSuperior, cuotaFija, tasa].
import type { TablaIsr } from "../declaraciones/isr-tablas.ts";

export type { TablaIsr, FilaTablaIsr } from "../declaraciones/isr-tablas.ts";

/** ISR nómina mensual — LISR Art. 96, tabla 2026 (Anexo 8 RMF 2026).
 * Puerto de `ISR_MENSUAL_2026` (fiscal_tables.py). */
export const ISR_NOMINA_MENSUAL_2026: TablaIsr = [
  [0.01, 844.59, 0.0, 0.0192],
  [844.6, 7168.51, 16.22, 0.064],
  [7168.52, 13074.34, 420.95, 0.1088],
  [13074.35, 16217.55, 1073.89, 0.16],
  [16217.56, 22089.52, 1576.78, 0.2136],
  [22089.53, 36113.04, 2830.39, 0.2352],
  [36113.05, 66356.44, 6128.72, 0.3],
  [66356.45, 96006.05, 15201.73, 0.32],
  [96006.06, 133596.27, 24729.61, 0.34],
  [133596.28, Infinity, 37530.25, 0.35],
];

/** ISR nómina anual — LISR Art. 96, tabla 2026. Derivada por el Python
 * original de la tabla mensual ×12 con redondeo (comentario propio de
 * fiscal_tables.py) — hereda una discontinuidad de ~$480 en el límite entre
 * tramo 8 y 9 (diseño §5.7). No alcanzable desde `nomina_completa` en
 * producción (solo mensual se ejercita hoy), pero `calculate_isr(annual=True)`
 * es parte del contrato público de la función, así que se porta completa.
 * Puerto de `ISR_ANUAL_2026` (fiscal_tables.py). */
export const ISR_NOMINA_ANUAL_2026: TablaIsr = [
  [0.01, 10135.08, 0.0, 0.0192],
  [10135.09, 86022.12, 194.64, 0.064],
  [86022.13, 156892.08, 5051.4, 0.1088],
  [156892.09, 194610.6, 12886.68, 0.16],
  [194610.61, 265074.24, 18921.36, 0.2136],
  [265074.25, 433356.48, 33964.68, 0.2352],
  [433356.49, 796277.28, 73544.64, 0.3],
  [796277.29, 1152072.6, 182420.76, 0.32],
  [1152072.61, 1603155.24, 296755.32, 0.34],
  [1603155.25, Infinity, 450363.0, 0.35],
];
