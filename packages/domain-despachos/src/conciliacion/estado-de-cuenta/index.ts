// Punto de entrada de la importación de estados de cuenta (D-03): detecta el formato
// (CSV u OFX) y delega al parser correspondiente.
import { parsearCsvEstadoCuenta } from "./parser-csv.ts";
import { MAX_RENGLONES_ESTADO } from "./resultado.ts";
import { parsearOfxEstadoCuenta } from "./parser-ofx.ts";
import type { BancoMx, FormatoEstadoCuenta, ResultadoParseoEstado } from "./types.ts";

export { parsearCsvEstadoCuenta, parsearOfxEstadoCuenta, MAX_RENGLONES_ESTADO };
export { parsearMonto, centavosAPesos } from "./montos.ts";
export { parsearFechaMx, parsearFechaOfx } from "./fechas.ts";
export { clabeValida, bancoPorClabe, PERFILES_BANCO } from "./layouts.ts";
export { hashMovimiento, conceptoCanonico } from "./normalizacion.ts";
export { BANCOS_MX } from "./types.ts";
export type { BancoMx, FormatoEstadoCuenta, ResultadoParseoEstado, MovimientoImportado, ErrorRenglonEstado, AdvertenciaEstado, NuevoLoteEstadoCuenta, NuevoMovimientoEstadoCuenta, ResultadoGuardadoEstadoCuenta } from "./types.ts";

export interface OpcionesParseoEstado {
  readonly formato?: FormatoEstadoCuenta;
  readonly banco?: BancoMx;
  readonly cuenta?: string | null;
}

/** OFX si trae la etiqueta <OFX> (o la cabecera OFXHEADER) en los primeros 4 KB; si no, CSV. */
export function detectarFormato(texto: string): FormatoEstadoCuenta {
  const inicio = texto.slice(0, 4096);
  return /<OFX>|OFXHEADER:/i.test(inicio) ? "ofx" : "csv";
}

export function parsearEstadoDeCuenta(texto: string, opciones: OpcionesParseoEstado = {}): ResultadoParseoEstado {
  const formato = opciones.formato ?? detectarFormato(texto);
  const base = { ...(opciones.banco ? { banco: opciones.banco } : {}), ...(opciones.cuenta !== undefined ? { cuenta: opciones.cuenta } : {}) };
  return formato === "ofx" ? parsearOfxEstadoCuenta(texto, base) : parsearCsvEstadoCuenta(texto, base);
}
export { construirVistaPreviaImportacion, MAX_MOVIMIENTOS_CONCILIACION } from "./previsualizacion.ts";
export type { VistaPreviaImportacion, CoincidenciaImportacion, EntradaVistaPrevia, CuentaPorCobrarPendiente } from "./previsualizacion.ts";
