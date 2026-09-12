// ═══════════════════════════════════════════════════════════════════════════
// TABLAS ISR — puerto 1:1 de las constantes de
// ~/Desktop/supabase/despachos/b2b_ai/fiscal_tables.py e
// ~/Desktop/supabase/despachos/b2b_ai/features/declaraciones/engine.py.
// Archivo de SOLO DATOS: ninguna lógica de clasificación de tramo vive aquí (eso es
// isr-engine.ts). Los números fueron verificados ejecutando el intérprete Python real
// (ver tests/fixtures/golden_gen_declaraciones.py + golden-declaraciones-output.json),
// no transcritos a mano de la fuente.
//
// NOTA DE FIDELIDAD (ver diseño Fase 2 §1, hallazgo previo al diseño): el motor de
// declaraciones que HOY correría en producción (`engine.py`) importa por NOMBRE FIJO
// `ISR_MENSUAL_2025`/`ISR_ANUAL_2025` de fiscal_tables.py — NO llama a
// `get_isr_table(FISCAL_YEAR)` pese a que fiscal_tables.py ya trae tablas 2024/2025/
// 2026 con selector por año. Es decir: aunque `fiscal_tables.FISCAL_YEAR = 2026`, el
// código que corre HOY usa la tarifa 2025 sin importar el año fiscal real. Fase 2
// porta ESE comportamiento real (fidelidad estricta), no lo "corrige" — un cambio de
// año fiscal en producción (arreglar `service.py` en el repo Python para que sí llame
// `get_isr_table(FISCAL_YEAR)`) es un hallazgo separado, fuera de alcance de este
// port (no se toca el Python de referencia). Por eso las funciones de isr-engine.ts
// reciben la tabla como parámetro con un default documentado — nunca una constante de
// módulo importada ciegamente una sola vez, como hace el propio `engine.py`.
//
// Formato de cada fila: [limiteInferior, limiteSuperior, cuotaFija, tasa]. El campo
// `limiteSuperior` NUNCA se usa para clasificar el tramo (ver isr-engine.ts,
// aplicarTablaIsr) — solo documenta el rango, igual que en el Python original donde
// `upper` se desestructura pero jamás se lee dentro de `_apply_isr_table`.
export type FilaTablaIsr = readonly [limiteInferior: number, limiteSuperior: number, cuotaFija: number, tasa: number];
export type TablaIsr = readonly FilaTablaIsr[];

/** ISR PF mensual — LISR Art. 96, ejercicio fiscal 2025 (RMF 2025, Anexo 3).
 * Puerto de `ISR_MENSUAL_2025` (fiscal_tables.py) == `ISR_TABLE_MONTHLY` (engine.py). */
export const ISR_PF_MENSUAL_2025: TablaIsr = [
  [0.0, 416.34, 0.0, 0.0192],
  [416.35, 3508.42, 7.99, 0.064],
  [3508.43, 6145.58, 205.29, 0.1088],
  [6145.59, 7185.25, 492.98, 0.16],
  [7185.26, 8564.67, 659.32, 0.2136],
  [8564.68, 17128.42, 952.82, 0.2352],
  [17128.43, 34256.83, 2963.16, 0.3],
  [34256.84, 45675.74, 8099.64, 0.32],
  [45675.75, 91351.48, 11753.69, 0.34],
  [91351.49, Infinity, 27285.41, 0.35],
];

/** ISR PF anual — LISR Art. 96, ejercicio fiscal 2025.
 * Puerto de `ISR_ANUAL_2025` (fiscal_tables.py) == `ISR_TABLE_ANNUAL` (engine.py). */
export const ISR_PF_ANUAL_2025: TablaIsr = [
  [0.0, 4996.07, 0.0, 0.0192],
  [4996.08, 42101.07, 95.93, 0.064],
  [42101.08, 73747.05, 2464.95, 0.1088],
  [73747.06, 86222.93, 5921.82, 0.16],
  [86222.94, 102775.97, 7918.14, 0.2136],
  [102775.98, 205540.72, 11454.29, 0.2352],
  [205540.73, 411081.46, 35594.91, 0.3],
  [411081.47, 548108.74, 97257.13, 0.32],
  [548108.75, 1096217.44, 141065.88, 0.34],
  [1096217.45, Infinity, 327422.79, 0.35],
];

/** ISR PM mensual bajo RESICO (LISR Art. 206, 209) — puerto literal de
 * `ISR_PM_MENSUAL_RESICO` (engine.py). El último tramo preserva la cuota fija con
 * 4 DECIMALES de la fuente (86799.1675, no 86799.17) — ver diseño §2.3: truncarla a 2
 * decimales antes de sumar el excedente produce un centavo de diferencia en el
 * resultado final cerca del quiebre. NO redondear esta constante. */
export const ISR_PM_MENSUAL_RESICO: TablaIsr = [
  [0.0, 25000.0, 0.0, 0.01],
  [25000.01, 50000.0, 250.0, 0.011],
  [50000.01, 83333.33, 525.0, 0.015],
  [83333.34, 208333.33, 1025.0, 0.02],
  [208333.34, 3500000.0, 3525.0, 0.025],
  [3500000.01, Infinity, 86799.1675, 0.03],
];

/** ISR PM — tasa fija (LISR Art. 9, personas morales). Puerto de `ISR_PM_RATE`. */
export const ISR_PM_TASA = 0.3;
