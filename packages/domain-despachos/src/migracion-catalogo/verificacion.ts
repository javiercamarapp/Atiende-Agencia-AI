// Puerto de `b2b_ai/features/migracion_catalogo/verificacion.py` — checks de
// solo-lectura (guard-only, nunca escriben nada) que se corren antes de "cerrar" una
// migración de catálogo. Todas las tolerancias son EXACTAS al origen.
import { CuentaContableNoEncontradaError, DiscrepanciaBalancePolizaError, DiscrepanciaConteoPolizasError, DiscrepanciaCuadreSaldoError, ReferenciasHuerfanasError } from "./types.ts";
import type { LineaMigrada } from "./migrador.ts";

/** REQ-MIG-014 — tolerancia EXACTA 0 (no 0.01): cualquier diferencia debe/haber
 * dentro de una póliza ya migrada es una discrepancia. */
export const TOLERANCIA_BALANCE_POLIZA = 0;

/** REQ-MIG-012 — tolerancia 0.01 MXN, estrictamente `>` (una diferencia IGUAL a la
 * tolerancia SÍ cuadra). */
export const TOLERANCIA_CUADRE_MXN_DEFAULT = 0.01;

/** El origen usa `Decimal` de Python para estas comparaciones (exacto, sin ruido de
 * punto flotante); aquí se opera con `number` (igual que el resto de
 * domain-despachos, ver `redondeo.ts` de nómina). Para que una diferencia de
 * centavos EXACTA (ej. 100.01 - 100 = 0.01) no aparezca como "0.010000000000005"
 * por representación binaria de punto flotante y dispare un falso positivo en la
 * comparación estricta `>`, la diferencia se redondea a centavos antes de
 * compararla contra la tolerancia — un monto contable nunca tiene más de 2
 * decimales, así que esto no oculta ninguna discrepancia real. */
function diferenciaEnCentavos(a: number, b: number): number {
  return Math.round((Math.abs(a - b) + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------------
// REQ-MIG-013 — conteo de pólizas (tolerancia 0, cualquier dirección bloquea).
// ---------------------------------------------------------------------------------
export function verificarConteoPolizas(countOrigenElegibles: number, countDestinoMigradas: number): void {
  if (countOrigenElegibles !== countDestinoMigradas) {
    throw new DiscrepanciaConteoPolizasError(countOrigenElegibles, countDestinoMigradas);
  }
}

// ---------------------------------------------------------------------------------
// REQ-MIG-014 — balance por póliza migrada.
// ---------------------------------------------------------------------------------
export interface DiscrepanciaBalancePoliza {
  readonly polizaId: string;
  readonly sumaDebe: number;
  readonly sumaHaber: number;
  readonly diferencia: number;
}

/** Agrupa `lineas` por `polizaOrigenId` y reporta cualquier póliza cuya diferencia
 * debe/haber exceda `TOLERANCIA_BALANCE_POLIZA` (0). Conjunto vacío → sin
 * discrepancias (cuadra vacuamente, igual que el origen). */
export function detectarDiscrepanciasBalancePorPoliza(lineas: readonly LineaMigrada[], tolerancia: number = TOLERANCIA_BALANCE_POLIZA): readonly DiscrepanciaBalancePoliza[] {
  const porPoliza = new Map<string, { debe: number; haber: number }>();
  for (const l of lineas) {
    const acc = porPoliza.get(l.polizaOrigenId) ?? { debe: 0, haber: 0 };
    acc.debe += l.debe;
    acc.haber += l.haber;
    porPoliza.set(l.polizaOrigenId, acc);
  }

  const discrepancias: DiscrepanciaBalancePoliza[] = [];
  for (const [polizaId, { debe, haber }] of porPoliza) {
    const diferencia = diferenciaEnCentavos(debe, haber);
    if (diferencia > tolerancia) {
      discrepancias.push({ polizaId, sumaDebe: debe, sumaHaber: haber, diferencia });
    }
  }
  return discrepancias;
}

export function verificarBalancePorPoliza(lineas: readonly LineaMigrada[], tolerancia: number = TOLERANCIA_BALANCE_POLIZA): void {
  const discrepancias = detectarDiscrepanciasBalancePorPoliza(lineas, tolerancia);
  if (discrepancias.length > 0) {
    const primera = discrepancias[0]!;
    throw new DiscrepanciaBalancePolizaError(primera.polizaId, primera.diferencia);
  }
}

// ---------------------------------------------------------------------------------
// REQ-MIG-012 — cuadre de saldos por cuenta migrada.
// ---------------------------------------------------------------------------------

/** `calcular_saldo_cuenta_periodo` — dado el conjunto de asientos ya filtrados por
 * `(tenantId, fecha en rango, cuentaDebito=cuentaId OR cuentaCredito=cuentaId)`
 * (el filtrado/carga es responsabilidad del llamador), calcula el saldo neto según
 * la naturaleza contable: acreedora ("A") = crédito - débito; cualquier otro valor
 * (deudora "D" u otro) = débito - crédito. */
export function calcularSaldoCuentaPeriodo(asientos: ReadonlyArray<{ readonly cuentaDebito: string; readonly cuentaCredito: string; readonly monto: number }>, cuentaId: string, naturaleza: string): number {
  let totalDebito = 0;
  let totalCredito = 0;
  for (const a of asientos) {
    if (a.cuentaDebito === cuentaId) totalDebito += a.monto;
    if (a.cuentaCredito === cuentaId) totalCredito += a.monto;
  }
  return naturaleza === "A" ? totalCredito - totalDebito : totalDebito - totalCredito;
}

export interface ParCuadreSaldo {
  readonly cuentaOrigenId: string;
  readonly cuentaDestinoId: string;
  readonly saldoOrigenPeriodo: number;
  readonly saldoDestinoPeriodo: number;
}

export interface DiscrepanciaCuadreSaldo extends ParCuadreSaldo {
  readonly diferencia: number;
}

/** Solo evalúa mapeos ya migrados (aprobado/editado) — el llamador arma `pares` a
 * partir de eso; si un mapeo migrado no tiene `destinoCuentaId`, es responsabilidad
 * del llamador reportarlo aparte (estado inconsistente, no lo produce esta
 * función). `>` estricto: diferencia == tolerancia SÍ cuadra. */
export function detectarDiscrepanciasCuadreSaldos(pares: readonly ParCuadreSaldo[], tolerancia: number = TOLERANCIA_CUADRE_MXN_DEFAULT): readonly DiscrepanciaCuadreSaldo[] {
  const discrepancias: DiscrepanciaCuadreSaldo[] = [];
  for (const par of pares) {
    const diferencia = diferenciaEnCentavos(par.saldoDestinoPeriodo, par.saldoOrigenPeriodo);
    if (diferencia > tolerancia) {
      discrepancias.push({ ...par, diferencia });
    }
  }
  return discrepancias;
}

export function verificarCuadreSaldos(pares: readonly ParCuadreSaldo[], tolerancia: number = TOLERANCIA_CUADRE_MXN_DEFAULT): void {
  const discrepancias = detectarDiscrepanciasCuadreSaldos(pares, tolerancia);
  if (discrepancias.length > 0) {
    const primera = discrepancias[0]!;
    throw new DiscrepanciaCuadreSaldoError(primera.cuentaDestinoId, primera.diferencia, tolerancia);
  }
}

/** Cuando una cuenta referenciada por el cuadre de saldos no existe en el
 * catálogo cargado — el origen NUNCA asume saldo $0 para una cuenta inexistente. */
export function requerirCuentaExiste<T>(cuenta: T | null | undefined, cuentaId: string): T {
  if (cuenta === null || cuenta === undefined) throw new CuentaContableNoEncontradaError(cuentaId);
  return cuenta;
}

// ---------------------------------------------------------------------------------
// REQ-MIG-015 — referencias huérfanas (línea migrada cuya cuenta destino ya no
// existe en el catálogo — la FK real ya lo previene estructuralmente en Postgres;
// esta es una segunda capa defensiva de solo lectura).
// ---------------------------------------------------------------------------------
export function detectarReferenciasHuerfanas(lineasMigradas: readonly LineaMigrada[], cuentasDestinoExistentesIds: ReadonlySet<string>): readonly LineaMigrada[] {
  return lineasMigradas.filter((l) => !cuentasDestinoExistentesIds.has(l.cuentaDestinoId));
}

export function verificarSinReferenciasHuerfanas(lineasMigradas: readonly LineaMigrada[], cuentasDestinoExistentesIds: ReadonlySet<string>): void {
  const huerfanas = detectarReferenciasHuerfanas(lineasMigradas, cuentasDestinoExistentesIds);
  if (huerfanas.length > 0) {
    throw new ReferenciasHuerfanasError(huerfanas.length);
  }
}

// ---------------------------------------------------------------------------------
// `cerrar_migracion` — corre las 4 verificaciones en orden; lanza en la primera que
// falle (guard-only, no escribe nada). El llamador arma cada input ya cargado.
// ---------------------------------------------------------------------------------
export interface InputCierreMigracion {
  readonly countOrigenElegibles: number;
  readonly countDestinoMigradas: number;
  readonly lineasMigradas: readonly LineaMigrada[];
  readonly paresCuadreSaldo: readonly ParCuadreSaldo[];
  readonly cuentasDestinoExistentesIds: ReadonlySet<string>;
  readonly toleranciaCuadreSaldo?: number;
}

export function cerrarMigracion(input: InputCierreMigracion): void {
  verificarConteoPolizas(input.countOrigenElegibles, input.countDestinoMigradas);
  verificarBalancePorPoliza(input.lineasMigradas);
  verificarCuadreSaldos(input.paresCuadreSaldo, input.toleranciaCuadreSaldo ?? TOLERANCIA_CUADRE_MXN_DEFAULT);
  verificarSinReferenciasHuerfanas(input.lineasMigradas, input.cuentasDestinoExistentesIds);
}
