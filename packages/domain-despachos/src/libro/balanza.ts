// D-24 -- puente entre la balanza derivada del libro (centavos enteros) y el generador del paquete de contabilidad electrónica
// (que trabaja con cuentas del catálogo Anexo 24 y montos decimales). Los montos se convierten a texto EXACTO (sin flotantes).
import { generarPaqueteContabilidadElectronica } from "../contabilidad-electronica/paquete.ts";
import type { TipoEnvioBalanza } from "../contabilidad-electronica/balanza.ts";
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

/** Catálogo del libro como `CuentaAnexo24`: nivel, cuenta padre (`SubCtaDe`) y código agrupador (`CodAgrup`) son los GUARDADOS en el libro
 * (migración 028), ya no se infieren por los ceros del código. Una cuenta sin código agrupador sigue sin él: el XML se niega a generarse. */
export function catalogoLibroAAnexo24(cuentas: readonly CuentaLibro[]): readonly CuentaAnexo24[] {
  return cuentas.map((c) => ({
    codigo: c.codigo,
    descripcion: c.descripcion,
    nivel: c.nivel ?? 1,
    naturaleza: c.naturaleza,
    grupo: GRUPOS[c.codigo.charAt(0)] ?? "Otros",
    subCtaDe: c.cuentaPadre ?? null,
    codAgrup: c.codigoAgrupador ?? null,
  }));
}

/** Paquete (catálogo + balanza XML con SHA-1) del mes a partir del libro. SIN cotejar con el validador del SAT en línea (las pruebas lo cotejan con el XSD). */
export function generarPaqueteDesdeLibro(args: {
  readonly cuentas: readonly CuentaLibro[];
  readonly balanza: readonly LineaBalanzaLibro[];
  readonly ejercicio: number;
  readonly mes: number;
  readonly rfc: string;
  readonly razonSocial: string;
  readonly generadoEn: string;
  readonly tipoEnvio?: TipoEnvioBalanza;
  readonly fechaModBal?: string;
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
    tipoEnvio: args.tipoEnvio,
    fechaModBal: args.fechaModBal,
  });
}
