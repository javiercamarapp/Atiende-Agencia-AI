// D-24 -- catálogo base de cuentas de un cliente nuevo. Se deriva de `CATALOGO_CUENTAS_SAT` (el mismo catálogo que ya usa el
// clasificador de pólizas del paquete), así que las cuentas que `construirPolizaDesdeCfdi` necesita existen siempre.
// La naturaleza se deduce del primer dígito (1 activo, 5 costos y 6 gastos = deudora; 2 pasivo, 3 capital, 4 ingresos =
// acreedora) con las cuentas de naturaleza contraria declaradas aquí abajo.
import { CATALOGO_CUENTAS_SAT } from "../bookkeeping/catalogo.ts";
import type { CuentaLibro } from "./types.ts";

/** Cuentas cuya naturaleza contradice la de su rubro. */
const NATURALEZA_EXCEPCION: Readonly<Record<string, "D" | "A">> = {
  "4020000": "D", // Devoluciones sobre ventas: minora el ingreso, saldo deudor.
  "2600300": "D", // IVA acreditable: a favor del contribuyente, saldo deudor.
};

export function naturalezaPorDefecto(codigo: string): "D" | "A" {
  const excepcion = NATURALEZA_EXCEPCION[codigo];
  if (excepcion) return excepcion;
  return "234".includes(codigo.charAt(0)) ? "A" : "D";
}

export function construirCatalogoBase(): readonly CuentaLibro[] {
  return Object.entries(CATALOGO_CUENTAS_SAT)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([codigo, descripcion]) => ({ codigo, descripcion, naturaleza: naturalezaPorDefecto(codigo) }));
}

/** Cuentas que usan las pólizas automáticas de CFDI (ver poliza-cfdi.ts). */
export const CUENTA_CLIENTES = "1050000";
export const CUENTA_INGRESOS_SERVICIOS = "4080000";
export const CUENTA_DEVOLUCIONES_VENTAS = "4020000";
export const CUENTA_IVA_TRASLADADO = "2600400";
export const CUENTA_IVA_ACREDITABLE = "2600300";
