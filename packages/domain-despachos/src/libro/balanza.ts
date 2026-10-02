// D-24 -- puente entre la balanza derivada del libro (centavos enteros) y el generador del paquete de contabilidad electrónica
// (que trabaja con cuentas del catálogo Anexo 24 y montos decimales). Los montos se convierten a texto EXACTO (sin flotantes).
import { generarPaqueteContabilidadElectronica } from "../contabilidad-electronica/paquete.ts";
import type { AsientoContable, CuentaAnexo24, PaqueteContabilidadElectronica } from "../contabilidad-electronica/types.ts";
import { centavosATexto } from "./poliza.ts";
import type { CuentaLibro, LineaBalanzaLibro } from "./types.ts";

export interface TotalesBalanzaLibro {
  readonly debeCentavos: number;
  readonly haberCentavos: number;
  readonly cuadrada: boolean;
}

export function totalesBalanza(lineas: readonly LineaBalanzaLibro[]): TotalesBalanzaLibro {
  const debeCentavos = lineas.reduce((s, l) => s + l.debeCentavos, 0);
  const haberCentavos = lineas.reduce((s, l) => s + l.haberCentavos, 0);
  return { debeCentavos, haberCentavos, cuadrada: debeCentavos === haberCentavos };
}

const GRUPOS: Readonly<Record<string, string>> = { "1": "Activo", "2": "Pasivo", "3": "Capital", "4": "Ingresos", "5": "Costos", "6": "Gastos" };

/** Catálogo del libro como `CuentaAnexo24` (nivel 1 = cuenta de mayor, 2 = subcuenta, 3 = auxiliar según los ceros finales). */
export function catalogoLibroAAnexo24(cuentas: readonly CuentaLibro[]): readonly CuentaAnexo24[] {
  return cuentas.map((c) => ({ codigo: c.codigo, descripcion: c.descripcion, nivel: c.codigo.endsWith("0000") ? 1 : c.codigo.endsWith("00") ? 2 : 3, naturaleza: c.naturaleza, grupo: GRUPOS[c.codigo.charAt(0)] ?? "Otros" }));
}

/** Paquete (catálogo + balanza XML con SHA-1) del mes a partir del libro. SIN cotejar con el validador del SAT. */
export function generarPaqueteDesdeLibro(args: {
  readonly cuentas: readonly CuentaLibro[];
  readonly balanza: readonly LineaBalanzaLibro[];
  readonly ejercicio: number;
  readonly mes: number;
  readonly rfc: string;
  readonly razonSocial: string;
  readonly generadoEn: string;
}): PaqueteContabilidadElectronica {
  const periodo = `${args.ejercicio}-${String(args.mes).padStart(2, "0")}`;
  const asientos: AsientoContable[] = args.balanza.map((l) => ({ cuenta: l.cuenta, debe: centavosATexto(l.debeCentavos), haber: centavosATexto(l.haberCentavos), fecha: `${periodo}-01` }));
  const saldosIniciales: Record<string, string> = {};
  for (const l of args.balanza) saldosIniciales[l.cuenta] = centavosATexto(l.saldoInicialCentavos);
  return generarPaqueteContabilidadElectronica({
    catalogo: catalogoLibroAAnexo24(args.cuentas),
    rfc: args.rfc,
    razonSocial: args.razonSocial,
    ejercicio: args.ejercicio,
    mes: args.mes,
    asientos,
    saldosIniciales,
    generadoEn: args.generadoEn,
    fechaModificacionXml: args.generadoEn.slice(0, 19),
  });
}
