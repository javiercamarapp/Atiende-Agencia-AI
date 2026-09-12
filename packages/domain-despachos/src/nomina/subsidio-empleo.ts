// ═══════════════════════════════════════════════════════════════════════════
// SUBSIDIO AL EMPLEO — puerto de `_calcular_subsidio`
// (nomina_completa/service.py) + las tablas que resuelve para 2026 vía
// `fiscal_tables.get_subsidio_table` (SUBSIDIO_EMPLEO_MENSUAL_2026,
// SUBSIDIO_EMPLEO_QUINCENAL_2026). LISR Art. 113 / Art. 174.
//
// NOTA DE FIDELIDAD (selector de tabla no portado, mismo criterio que
// isr-nomina-tablas.ts): `get_subsidio_table(year, period)` es un dispatcher
// multi-año/multi-periodo; aquí solo se porta lo que efectivamente resuelve
// para el ejercicio 2026 (el vigente, y el único que `nomina_completa` usa en
// producción hoy: `calculate_taxes` nunca pasa `year` explícito). El
// parámetro `tabla` explícito con default documentado reemplaza al selector
// —no se porta la indirección por año, solo el resultado que produce hoy—.
//
// NOTA DE FIDELIDAD (tabla de fidelidad dudosa, diseño §5.6): el propio
// `fiscal_tables.py` trae esta nota sobre la tabla mensual: "Los montos de
// subsidio por rango requieren verificación contra el decreto oficial...
// el ingreso máximo se actualizó a $11,492.66 según Anexo 8 RMF 2026" — es
// decir, el autor del Python original no está seguro de que sea la tabla
// oficial 2026 vigente. Se hereda tal cual (fidelidad al dato de origen, no
// al hecho legal) — es una limitación de la fuente, no de este puerto.
//
// NOTA DE FIDELIDAD (dos campos muertos omitidos a propósito): la función
// Python retorna `{"subsidio": ..., "subsidio_efectivo": 0.0, "isr_neto":
// 0.0}` — los dos últimos campos son SIEMPRE 0.0 en esta función (se
// recalculan, de verdad, en `calculate_taxes`, no aquí) — son placeholders
// muertos dentro de `_calcular_subsidio` en el Python original, confirmado
// leyendo el código. Este puerto retorna solo el número `subsidio` (el único
// campo con contenido real de esta función); `subsidioEfectivo`/`isrNeto`
// reales se calculan en payroll-engine.ts::calcularImpuestosNomina, que es
// donde el Python original realmente los calcula.
import { r2 } from "./redondeo.ts";

/** Fila de la tabla de subsidio: [limiteInferior, limiteSuperior, subsidio].
 * El Python original guarda estos tres valores como strings y los convierte
 * con `float()` al comparar — aquí son números desde el origen (JSON/TS no
 * necesita el paso intermedio de string). */
export type FilaSubsidio = readonly [limiteInferior: number, limiteSuperior: number, subsidio: number];
export type TablaSubsidio = readonly FilaSubsidio[];

export type Periodicidad = "mensual" | "quincenal";

/** Subsidio al empleo mensual 2026 (11 tramos) — puerto de
 * `SUBSIDIO_EMPLEO_MENSUAL_2026` (fiscal_tables.py). */
export const SUBSIDIO_EMPLEO_MENSUAL_2026: TablaSubsidio = [
  [0.01, 2169.53, 407.02],
  [2169.54, 3502.78, 406.83],
  [3502.79, 3861.48, 406.62],
  [3861.49, 4607.32, 392.77],
  [4607.33, 5090.8, 382.46],
  [5090.81, 6355.12, 354.24],
  [6355.13, 7470.57, 294.17],
  [7470.58, 8455.6, 253.54],
  [8455.61, 9912.54, 217.61],
  [9912.55, 11492.66, 209.13],
  [11492.67, 13493.97, 0.0],
];

/** Subsidio al empleo quincenal 2026 (mitad del mensual, tabla propia en la
 * fuente — no una división programática) — puerto de
 * `SUBSIDIO_EMPLEO_QUINCENAL_2026` (fiscal_tables.py). Alcanzable desde
 * `calculate_taxes` solo si se pasa `periodicidad="quincenal"` explícitamente
 * — no expuesto por ningún endpoint del sistema de referencia hoy (mismo
 * hallazgo que la rama quincenal de ISR, diseño §5.4). */
export const SUBSIDIO_EMPLEO_QUINCENAL_2026: TablaSubsidio = [
  [0.01, 1084.77, 203.51],
  [1084.78, 1751.39, 203.42],
  [1751.39, 1930.74, 203.31],
  [1930.75, 2303.66, 196.39],
  [2303.67, 2545.4, 191.23],
  [2545.41, 3177.56, 177.12],
  [3177.57, 3735.29, 147.09],
  [3735.3, 4227.8, 126.77],
  [4227.81, 4956.27, 108.81],
  [4956.28, 5820.88, 104.57],
  [5820.89, 6746.99, 0.0],
];

/** Puerto de `_calcular_subsidio` (solo el campo `subsidio`, ver nota de
 * fidelidad arriba). `ingresoGravado <= 0` retorna 0 sin tocar la tabla,
 * igual que el Python. Clasifica con `lower <= x <= upper` (mismo estilo que
 * `calculate_isr` de nómina — ambos leídos de `compliance.py`/
 * `nomina_completa/service.py`, no del algoritmo de declaraciones). */
export function calcularSubsidio(ingresoGravado: number, periodicidad: Periodicidad = "mensual", tabla?: TablaSubsidio): number {
  if (ingresoGravado <= 0) return 0;
  const t = tabla ?? (periodicidad === "quincenal" ? SUBSIDIO_EMPLEO_QUINCENAL_2026 : SUBSIDIO_EMPLEO_MENSUAL_2026);

  let subsidio = 0;
  for (const [lower, upper, sub] of t) {
    if (lower <= ingresoGravado && ingresoGravado <= upper) {
      subsidio = sub;
      break;
    }
  }
  return r2(subsidio);
}
