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

/**
 * Código agrupador del SAT (Anexo 24) PROPUESTO para cada cuenta del catálogo base. Todos están en la lista cerrada del XSD (lo comprueba
 * tests/libro-catalogo-sat.spec.ts), pero la correspondencia cuenta -> código es un supuesto que el fiscalista debe validar (ficha
 * normas/anexo-24-codigo-agrupador.yaml, estado `por_verificar`): el despacho puede cambiar cualquiera con la pestaña Catálogo.
 */
export const CODIGO_AGRUPADOR_BASE: Readonly<Record<string, string>> = {
  "1020000": "102", "1020100": "102.01", "1020200": "102.02",
  "1050000": "105", "1050100": "105.01", "1050200": "105.02",
  "1080000": "107",
  "1100000": "109",
  "1130000": "115",
  "1500000": "151", "1520000": "152", "1540000": "153", "1560000": "155", "1580000": "154", "1600000": "156",
  "1900000": "190",
  "2010000": "201.01", "2020000": "201.02", "2050000": "202", "2080000": "204",
  "2600000": "213", "2600100": "213.01", "2600200": "213.01", "2600300": "118.01", "2600400": "208.01", "2600500": "216.01",
  "2670000": "210",
  "3010000": "301", "3040000": "305", "3050000": "306",
  "4010000": "401", "4020000": "402", "4080000": "401.01", "4100000": "401",
  "5010000": "501", "5020000": "502",
  "6010100": "601.01", "6010200": "601.01", "6010300": "601.01", "6010400": "601.01", "6010500": "601.01", "6010600": "601.01", "6010700": "601.01", "6010800": "601.01", "6010900": "601.01",
  "6020100": "601", "6020200": "601", "6020300": "601", "6020400": "601", "6020500": "601", "6020600": "601", "6020700": "601",
  "6030100": "701", "6030200": "701",
  "6040100": "601",
  "6050100": "702",
  "6070100": "703",
  "6080100": "601", "6090100": "601", "6100100": "601", "6110100": "601",
};

/** Cuenta de mayor de una subcuenta del catálogo base: los 4 primeros dígitos más «000» (1020100 -> 1020000), si existe y es otra cuenta. */
function padreBase(codigo: string): string | null {
  const candidato = `${codigo.slice(0, 4)}000`;
  return candidato !== codigo && candidato in CATALOGO_CUENTAS_SAT ? candidato : null;
}

export function construirCatalogoBase(): readonly CuentaLibro[] {
  return Object.entries(CATALOGO_CUENTAS_SAT)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([codigo, descripcion]) => {
      const cuentaPadre = padreBase(codigo);
      return { codigo, descripcion, naturaleza: naturalezaPorDefecto(codigo), nivel: cuentaPadre ? 2 : 1, cuentaPadre, codigoAgrupador: CODIGO_AGRUPADOR_BASE[codigo] ?? null };
    });
}

// PENDIENTE DE VALIDAR CON EL CONTADOR: el catálogo base, la naturaleza deducida del primer dígito y las cuentas de abajo son supuestos
// (agrupador del SAT) y no la decisión de cada despacho; cada cliente puede cambiar su catálogo con `libro_cuenta_guardar`.
/** Cuentas que usan las pólizas automáticas de CFDI (ver poliza-cfdi.ts). */
export const CUENTA_CLIENTES = "1050000";
export const CUENTA_INGRESOS_SERVICIOS = "4080000";
export const CUENTA_DEVOLUCIONES_VENTAS = "4020000";
export const CUENTA_IVA_TRASLADADO = "2600400";
export const CUENTA_IVA_ACREDITABLE = "2600300";
