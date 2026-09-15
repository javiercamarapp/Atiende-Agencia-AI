// ═══════════════════════════════════════════════════════════════════════════
// TABLAS ISR — FUENTE ÚNICA DE VERDAD para la tarifa del Art. 96/152 LISR
// (retenciones/pagos provisionales y cálculo anual de personas físicas) tal
// como la publica el SAT en el Anexo 8 de la Resolución Miscelánea Fiscal
// (RMF) cada ejercicio, en el Diario Oficial de la Federación (DOF).
//
// CORRECCIÓN FISCAL (auditoría — hallazgo CRÍTICO #1, severidad legal
// directa): la versión anterior de este archivo tenía DOS defectos reales,
// no cosméticos:
//   1. Los valores de `ISR_PF_MENSUAL_2025`/`ISR_PF_ANUAL_2025` NO
//      correspondían a la tarifa 2025 oficial (Anexo 8 RMF 2025, DOF) — eran
//      valores obsoletos (de un ejercicio anterior a la actualización por
//      inflación), verificados y descartados contra el DOF real.
//   2. `nomina/isr-nomina-tablas.ts` mantenía una SEGUNDA copia de la MISMA
//      tarifa legal (Art. 96 LISR — no existe una "tabla de nómina"
//      distinta de la tabla general: es la misma tarifa que usa cualquier
//      retención periódica del Art. 96), con OTROS valores (2026), sin
//      selector de año compartido. Resultado: para la MISMA base gravable,
//      el motor de "declaraciones" (honorarios/PF) y el motor de "nómina"
//      daban un ISR distinto — una contradicción interna sin fundamento
//      legal (la tarifa del Art. 96 es UNA sola por ejercicio fiscal).
//
// FIX: este archivo es ahora la única fuente de las tarifas Art. 96/152 —
// nomina/isr-nomina-tablas.ts se limita a RE-EXPORTAR estas mismas
// constantes (ver ese archivo). Se conservan los ejercicios 2025 Y 2026
// (ambos verificados campo por campo contra el Anexo 8 de su RMF respectiva,
// re-derivando cada cuota fija a partir de la fila anterior — ver el
// comentario de cada tabla) porque un despacho contable real necesita poder
// declarar/corregir periodos de AMBOS ejercicios, no solo "el año en curso"
// — pero ambos motores (`isr-engine.ts` y `nomina/isr-nomina-engine.ts`)
// ahora DEFAULTean al mismo ejercicio vigente (2026, el ejercicio en curso a
// la fecha de esta corrección), y solo cambian de tabla si el llamador pasa
// una tabla explícita — nunca por defaults distintos entre sí.
//
// Formato de cada fila: [limiteInferior, limiteSuperior, cuotaFija, tasa]. El
// campo `limiteSuperior` es solo documental (ver isr-engine.ts,
// `aplicarTablaIsr`: clasifica con el límite inferior de la fila SIGUIENTE,
// nunca con este campo — así lo hace también nomina/isr-nomina-engine.ts,
// que sí lee `upper` pero con `upper[i] === lower[i+1] - 0.01` en todas las
// filas de abajo, por lo que ambos algoritmos de clasificación coinciden
// para toda base gravable representable en centavos).
export type FilaTablaIsr = readonly [limiteInferior: number, limiteSuperior: number, cuotaFija: number, tasa: number];
export type TablaIsr = readonly FilaTablaIsr[];

/** ISR mensual (retenciones/pagos provisionales, Art. 96 LISR) — Anexo 8 RMF
 * 2025, DOF. Verificada fila por fila: cada `cuotaFija` reproduce
 * `cuotaFija[i-1] + (limiteSuperior[i-1] - limiteInferior[i-1]) * tasa[i-1]`
 * redondeado a 2 decimales, igual que el resto de la tarifa oficial. */
export const ISR_MENSUAL_2025: TablaIsr = [
  [0.01, 746.04, 0.0, 0.0192],
  [746.05, 6332.05, 14.32, 0.064],
  [6332.06, 11128.01, 371.83, 0.1088],
  [11128.02, 12935.82, 893.63, 0.16],
  [12935.83, 15487.71, 1182.88, 0.1792],
  [15487.72, 31236.49, 1640.18, 0.2136],
  [31236.5, 49233.0, 5004.12, 0.2352],
  [49233.01, 93993.9, 9236.89, 0.3],
  [93993.91, 125325.2, 22665.17, 0.32],
  [125325.21, 375975.61, 32691.18, 0.34],
  [375975.62, Infinity, 117912.32, 0.35],
];

/** ISR anual (declaración anual, Art. 152 LISR) — Anexo 8 RMF 2025, DOF.
 * Límites tal como los publica el SAT (tabla mensual × 12, cada campo
 * redondeado de forma independiente por fila — de ahí que el salto entre el
 * límite superior de una fila y el límite inferior de la siguiente NO sea
 * siempre $0.01 exacto, a diferencia de la tabla mensual; es el mismo
 * patrón del Anexo 8 oficial, no un error de transcripción). */
export const ISR_ANUAL_2025: TablaIsr = [
  [0.12, 8952.48, 0.0, 0.0192],
  [8952.6, 75984.6, 171.84, 0.064],
  [75984.72, 133536.12, 4461.96, 0.1088],
  [133536.24, 155229.84, 10723.56, 0.16],
  [155229.96, 185852.52, 14194.56, 0.1792],
  [185852.64, 374837.88, 19682.16, 0.2136],
  [374838.0, 590796.0, 60049.44, 0.2352],
  [590796.12, 1127926.8, 110842.68, 0.3],
  [1127926.92, 1503902.4, 271982.04, 0.32],
  [1503902.52, 4511707.32, 392294.16, 0.34],
  [4511707.44, Infinity, 1414947.84, 0.35],
];

/** ISR mensual (retenciones/pagos provisionales, Art. 96 LISR) — Anexo 8 RMF
 * 2026, DOF 28-dic-2025. Ejercicio VIGENTE (ver nota de cabecera): es el
 * default de `calcularIsrPf`/`calcularIsrNomina` a partir de esta
 * corrección. */
export const ISR_MENSUAL_2026: TablaIsr = [
  [0.01, 844.59, 0.0, 0.0192],
  [844.6, 7168.51, 16.22, 0.064],
  [7168.52, 12598.02, 420.95, 0.1088],
  [12598.03, 14644.64, 1011.68, 0.16],
  [14644.65, 17533.64, 1339.14, 0.1792],
  [17533.65, 35362.83, 1856.84, 0.2136],
  [35362.84, 55736.68, 5665.16, 0.2352],
  [55736.69, 106410.5, 10457.09, 0.3],
  [106410.51, 141880.66, 25659.23, 0.32],
  [141880.67, 425641.99, 37009.69, 0.34],
  [425642.0, Infinity, 133488.54, 0.35],
];

/** ISR anual (declaración anual, Art. 152 LISR) — Anexo 8 RMF 2026, DOF
 * 28-dic-2025. Ejercicio VIGENTE (ver nota de cabecera). Mismo criterio de
 * límites "tal como los publica el SAT" que `ISR_ANUAL_2025` (ver su
 * comentario). */
export const ISR_ANUAL_2026: TablaIsr = [
  [0.12, 10135.08, 0.0, 0.0192],
  [10135.2, 86022.12, 194.64, 0.064],
  [86022.24, 151176.24, 5051.4, 0.1088],
  [151176.36, 175735.68, 12140.16, 0.16],
  [175735.8, 210403.68, 16069.68, 0.1792],
  [210403.8, 424353.96, 22282.08, 0.2136],
  [424354.08, 668840.16, 67981.92, 0.2352],
  [668840.28, 1276926.0, 125485.08, 0.3],
  [1276926.12, 1702567.92, 307910.76, 0.32],
  [1702568.04, 5107703.88, 444116.28, 0.34],
  [5107704.0, Infinity, 1601862.48, 0.35],
];

// ─────────────────────────────────────────────────────────────────────────
// Alias retrocompatibles: código existente (rutas HTTP, otros paquetes) que
// importaba `ISR_PF_MENSUAL_2025`/`ISR_PF_ANUAL_2025` sigue funcionando sin
// cambios — apuntan a las MISMAS tablas verificadas arriba, ya no a datos
// distintos. El default operativo de los motores es 2026 (ver isr-engine.ts
// y nomina/isr-nomina-engine.ts); estos alias 2025 quedan disponibles para
// declarar/corregir periodos de ese ejercicio explícitamente.
export const ISR_PF_MENSUAL_2025 = ISR_MENSUAL_2025;
export const ISR_PF_ANUAL_2025 = ISR_ANUAL_2025;

/** ISR PF RESICO mensual (LISR Art. 113-E) — tasas 2022-2026 sin cambio
 * (no están indexadas a inflación, a diferencia de la tarifa Art. 96). OJO:
 * a diferencia de `ISR_MENSUAL_*`/`ISR_ANUAL_*` de arriba, el Art. 113-E NO
 * es una tarifa progresiva de cuota-fija-más-excedente — el SAT aplica la
 * tasa del tramo en el que cae el ingreso ACUMULADO del mes de forma PLANA
 * sobre la TOTALIDAD de ese ingreso (ej.: ingreso $30,000 -> tasa 1.10% ->
 * ISR = $330.00, no "cuota fija + excedente×tasa"). Las `cuotaFija`
 * codificadas abajo son una reconstrucción de continuidad que NO reproduce
 * ese cálculo real tramo a tramo salvo en el límite inferior exacto de cada
 * tramo — ver hallazgo separado (fuera del alcance de esta corrección,
 * reportado aparte): `calcularIsrPmResico` YA NO usa esta tabla (ver
 * isr-engine.ts, corrección hallazgo CRÍTICO #2 — RESICO PM es tasa plana
 * de 30% sobre flujo de efectivo, Art. 206/209, NUNCA esta tabla de RESICO
 * PERSONA FÍSICA). Esta tabla se conserva únicamente por si algún llamador
 * externo aún la importaba por su nombre histórico; no se usa en ningún
 * cálculo de este paquete a partir de esta corrección. */
export const RESICO_PF_MENSUAL: TablaIsr = [
  [0.0, 25000.0, 0.0, 0.01],
  [25000.01, 50000.0, 250.0, 0.011],
  [50000.01, 83333.33, 525.0, 0.015],
  [83333.34, 208333.33, 1025.0, 0.02],
  [208333.34, 3500000.0, 3525.0, 0.025],
  [3500000.01, Infinity, 86799.1675, 0.03],
];

/** @deprecated Nombre histórico de `RESICO_PF_MENSUAL` — hallazgo CRÍTICO #2
 * de la auditoría: este nombre ("...PM...") era el propio bug: es la tabla
 * de RESICO PERSONA FÍSICA (Art. 113-E), no la de RESICO persona moral (que
 * es tasa plana 30%, Art. 206/209 — ver `ISR_PM_TASA` y
 * `calcularIsrPmResico` en isr-engine.ts). Se conserva solo como alias para
 * no romper imports existentes; ningún cálculo de este paquete la usa ya
 * bajo este nombre. */
export const ISR_PM_MENSUAL_RESICO = RESICO_PF_MENSUAL;

/** ISR PM — tasa fija (LISR Art. 9, personas morales; también Art. 206/209
 * para RESICO PM sobre flujo de efectivo — misma tasa, base distinta). */
export const ISR_PM_TASA = 0.3;
