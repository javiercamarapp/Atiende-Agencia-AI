// Armado del resultado de parseo (totales, periodo) compartido por CSV y OFX.
import { centavosAPesos } from "./montos.ts";
import type { AdvertenciaEstado, BancoMx, ErrorRenglonEstado, FormatoEstadoCuenta, MovimientoImportado, ResultadoParseoEstado } from "./types.ts";

/** Tope defensivo: un estado de cuenta mensual empresarial rara vez pasa de unas
 * decenas de miles de renglones; el tope evita que un archivo enorme consuma memoria. */
export const MAX_RENGLONES_ESTADO = 20_000;

export function armar(
  formato: FormatoEstadoCuenta,
  banco: BancoMx,
  detectado: boolean,
  cuenta: string | null,
  moneda: string,
  movimientos: readonly MovimientoImportado[],
  errores: readonly ErrorRenglonEstado[],
  advertencias: readonly AdvertenciaEstado[],
  leidos: number,
  saldoFinalOverride: number | null = null,
): ResultadoParseoEstado {
  let cargos = 0;
  let abonos = 0;
  let desde: string | null = null;
  let hasta: string | null = null;
  for (const m of movimientos) {
    if (m.monto < 0) cargos += Math.round(-m.monto * 100);
    else abonos += Math.round(m.monto * 100);
    if (desde === null || m.fecha < desde) desde = m.fecha;
    if (hasta === null || m.fecha > hasta) hasta = m.fecha;
  }
  return {
    formato,
    banco,
    bancoDetectado: detectado,
    cuenta,
    moneda,
    movimientos,
    errores,
    advertencias,
    renglonesLeidos: leidos,
    periodo: desde !== null && hasta !== null ? { desde, hasta } : null,
    totalCargos: centavosAPesos(cargos),
    totalAbonos: centavosAPesos(abonos),
    saldoFinal: saldoFinalOverride,
  };
}

