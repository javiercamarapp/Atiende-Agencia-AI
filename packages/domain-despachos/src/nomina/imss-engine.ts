// ═══════════════════════════════════════════════════════════════════════════
// MOTOR IMSS / INFONAVIT DE NÓMINA — puerto de las 4 funciones `_calcular_*`
// de ~/Desktop/supabase/despachos/b2b_ai/features/nomina_completa/service.py.
// Puro, sin I/O. Verificado contra el intérprete Python real — ver
// tests/fixtures/golden_gen_nomina.py y tests/nomina-imss.spec.ts.
//
// NOTA DE FIDELIDAD (motor paralelo, ver diseño Fase 3 §1/§5.2): este es el
// motor de `nomina_completa` (el que se pidió portar), tasas PLANAS
// consolidadas sobre SBC topado — NO desglosa por rama LSS (EYM, IV, RCVA,
// GMP...) como sí hace el motor independiente `services/payroll.py`
// (`calc_imss`), que retiene ~2.6× más IMSS obrero para el mismo salario. Los
// dos motores conviven hoy en el sistema de referencia; este port sigue
// literalmente al que se indicó (`nomina_completa`), no al otro. Cuál de los
// dos alimenta facturación/nómina real es una decisión de producto pendiente
// de autorización explícita — no se resuelve en este port.
//
// NOTA DE FIDELIDAD (sin validación de SBC, diseño §5.5): a diferencia de
// `services/payroll.py::calc_imss` (que lanza `ValueError` si SBC<=0 o
// SBC<UMA, art. 107 LSS), estas funciones NO validan `salarioDiario > 0` ni
// `>= UMA`. Un salario negativo o cero produce IMSS negativo/cero sin aviso —
// se porta tal cual, no se agrega la validación que el propio motor de
// referencia (`nomina_completa`) no tiene.
//
// Constantes — ejercicio 2026 (LSS arts. 105-109, Ley INFONAVIT art. 29-II):
//   UMA diaria 2026 = round(UMA_MENSUAL_2026 / 30.4, 2) = 117.31
//   Tope SBC = 25 × UMA diaria = 2932.75
//   Obrero:   1.25%  del SBC×días (EYM 0.25% + IV 0.625% + CyV 0.375%, ya sumado)
//   Patronal: 14.25% del SBC×días (incluye el 5% de Infonavit dentro del total)
//   Infonavit (patronal): 5% del SBC×días — aportación del patrón, NO se
//     descuenta del neto del trabajador (Ley INFONAVIT art. 29-II).

/** UMA mensual 2026 — puerto de `UMA_MENSUAL_2026` (fiscal_tables.py, string
 * en el Python original: `"3566.22"`; aquí número, mismo valor). */
export const UMA_MENSUAL_2026 = 3566.22;

/** UMA diaria 2026 — puerto de `_UMA_DIARIA_2026` (service.py):
 * `round(UMA_MENSUAL_2026 / 30.4, 2)`. */
export const UMA_DIARIA_2026 = Math.round((UMA_MENSUAL_2026 / 30.4 + Number.EPSILON) * 100) / 100;

/** Tope de SBC en UMAs diarias (LSS art. 28) — puerto de `_SBC_MAX_UMA`. */
export const SBC_MAX_UMA = 25.0;

/** Tasa obrera IMSS (% del SBC×días) — puerto de `_IMSS_OBRERO_TASA`. */
export const IMSS_OBRERO_TASA = 0.0125;

/** Tasa patronal IMSS (% del SBC×días, incluye Infonavit) — puerto de
 * `_IMSS_PATRONAL_TASA`. */
export const IMSS_PATRONAL_TASA = 0.1425;

/** Tasa Infonavit patronal (% del SBC×días) — puerto de `_INFONAVIT_TASA`. */
export const INFONAVIT_TASA = 0.05;

/** Puerto de `_sbc_diario_topado` — topa el salario diario al SBC máximo
 * (25 UMA diarias, LSS art. 28). Sin validar `salarioDiario > 0` (ver nota de
 * fidelidad arriba): un negativo pasa sin tocar (`min` no lo topa hacia
 * arriba de cero). */
export function sbcDiarioTopado(salarioDiario: number, umaDiaria: number = UMA_DIARIA_2026, topeUma: number = SBC_MAX_UMA): number {
  return Math.min(salarioDiario, umaDiaria * topeUma);
}

/** Puerto de `_calcular_imss_obrero`. Retorna el valor SIN redondear — el
 * redondeo a 2 decimales ocurre en la capa de composición
 * (payroll-engine.ts::calcularImpuestosNomina), exactamente como en Python
 * (`_calcular_imss_obrero` no redondea; `calculate_taxes` sí, al construir
 * `PayrollTaxes`). */
export function calcularImssObrero(salarioDiario: number, diasPagados = 30): number {
  const basePeriodo = sbcDiarioTopado(salarioDiario) * diasPagados;
  return basePeriodo * IMSS_OBRERO_TASA;
}

/** Puerto de `_calcular_imss_patronal`. Sin redondear — ver nota arriba. */
export function calcularImssPatronal(salarioDiario: number, diasPagados = 30): number {
  const basePeriodo = sbcDiarioTopado(salarioDiario) * diasPagados;
  return basePeriodo * IMSS_PATRONAL_TASA;
}

/** Puerto de `_calcular_infonavit`. Aportación PATRONAL (Ley INFONAVIT
 * art. 29-II) — NO se descuenta del neto del trabajador. Sin redondear — ver
 * nota arriba. */
export function calcularInfonavit(salarioDiario: number, diasPagados = 30): number {
  const basePeriodo = sbcDiarioTopado(salarioDiario) * diasPagados;
  return basePeriodo * INFONAVIT_TASA;
}
