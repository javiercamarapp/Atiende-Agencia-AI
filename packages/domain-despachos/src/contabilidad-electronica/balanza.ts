// Balanza de comprobación mensual — puerto de
// `b2b_ai/services/balanza.py::BalanzaComprobacion` (XSD
// `balanzaComprobacion`, v1.3 del SAT).
//
// Funcional, mismo criterio que `catalogo-cuentas.ts`: sin clase con estado
// mutable (`self.lineas`/`self._asientos`), todo recibido y devuelto
// explícito.
import type { AsientoContable, CuentaAnexo24, LineaBalanza, LineaBalanzaAnomala, NaturalezaCuenta, ResumenBalanza } from "./types.ts";
import { findCuenta } from "./catalogo-cuentas.ts";
import { ContabilidadElectronicaDatosInvalidosError, escaparAtributoXml, exigirEjercicioYMes, exigirRfcSat, mesDosDigitos } from "./xml-comun.ts";

// `_round2`/`_fmt` del origen usan `Decimal.quantize(..., ROUND_HALF_UP)` —
// redondeo "mitad hacia arriba" explícito (NO el round-half-to-even de
// `nomina/redondeo.ts`, que porta el `round()` nativo de Python; aquí el
// origen usa `Decimal` con una política de redondeo distinta y explícita).
// `Math.round` en JS ya es half-up para valores positivos; el ajuste con
// `Number.EPSILON` evita el caso típico de error de punto flotante binario
// (p. ej. `1.005 * 100` cae en `100.49999...`) — mismo patrón ya usado en
// `cierre-mensual/engine.ts::r2` y `bookkeeping/rules-engine.ts::r2` de este
// mismo paquete.
function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function fmt2(n: number): string {
  return r2(n).toFixed(2);
}

/** `_dec` del origen — parsea a número con `default` si el valor es
 * `None`/`""`/no numérico. */
function toDec(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseSaldosIniciales(saldos: Readonly<Record<string, number | string>> | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, v] of Object.entries(saldos ?? {})) out.set(String(k), toDec(v));
  return out;
}

/** `BalanzaComprobacion.acumular` — acumula debe/haber por cuenta. */
export function acumularAsientos(asientos: readonly AsientoContable[] | null | undefined): Map<string, { debe: number; haber: number }> {
  const acc = new Map<string, { debe: number; haber: number }>();
  for (const a of asientos ?? []) {
    const cta = a.cuenta;
    if (!cta) continue;
    const key = String(cta);
    const entry = acc.get(key) ?? { debe: 0, haber: 0 };
    entry.debe += toDec(a.debe);
    entry.haber += toDec(a.haber);
    acc.set(key, entry);
  }
  return acc;
}

function descripcionCuenta(catalogo: readonly CuentaAnexo24[], codigo: string): string {
  const c = findCuenta(catalogo, codigo);
  return c ? c.descripcion : `Cuenta ${codigo}`;
}

function naturalezaCuenta(catalogo: readonly CuentaAnexo24[], codigo: string): NaturalezaCuenta {
  const c = findCuenta(catalogo, codigo);
  return c ? (c.naturaleza.toUpperCase() as NaturalezaCuenta) : "D";
}

function nivelCuenta(catalogo: readonly CuentaAnexo24[], codigo: string): number {
  const c = findCuenta(catalogo, codigo);
  return c ? c.nivel : 3;
}

/** `BalanzaComprobacion.generar` — construye la balanza del período desde
 * los asientos contables. Si `periodo` viene dado y los asientos traen
 * fecha, se filtra por mes (mismo criterio que el origen: un asiento sin
 * fecha NUNCA se excluye). */
export function generarBalanza(catalogo: readonly CuentaAnexo24[], asientos: readonly AsientoContable[] | null | undefined, periodo: string | null, saldosIniciales?: Readonly<Record<string, number | string>> | null): ResumenBalanza {
  const saldosIni = parseSaldosIniciales(saldosIniciales);

  let rows = asientos ?? [];
  if (periodo) {
    const p = String(periodo);
    rows = rows.filter((a) => a.fecha === null || a.fecha === undefined || String(a.fecha).slice(0, 7) === p);
  }

  const acc = acumularAsientos(rows);
  const cuentasOrdenadas = [...acc.keys()].sort();

  const lineas: LineaBalanza[] = cuentasOrdenadas.map((cta) => {
    const { debe, haber } = acc.get(cta)!;
    const saldoIni = saldosIni.get(cta) ?? 0;
    const nat = naturalezaCuenta(catalogo, cta);
    const saldoFin = nat === "D" ? saldoIni + debe - haber : saldoIni + haber - debe;
    return {
      cuenta: cta,
      descripcion: descripcionCuenta(catalogo, cta),
      nivel: nivelCuenta(catalogo, cta),
      naturaleza: nat,
      saldoInicial: fmt2(saldoIni),
      debe: fmt2(debe),
      haber: fmt2(haber),
      saldoFinal: fmt2(saldoFin),
    };
  });

  return resumenBalanza(periodo, lineas);
}

/** `BalanzaComprobacion.resumen`. */
export function resumenBalanza(periodo: string | null, lineas: readonly LineaBalanza[]): ResumenBalanza {
  const totalDebe = lineas.reduce((acc, l) => acc + toDec(l.debe), 0);
  const totalHaber = lineas.reduce((acc, l) => acc + toDec(l.haber), 0);
  return {
    periodo,
    cuentas: lineas.length,
    totalDebe: fmt2(totalDebe),
    totalHaber: fmt2(totalHaber),
    cuadrada: r2(totalDebe) === r2(totalHaber),
    saldosAnomalos: detectarSaldosAnomalos(lineas).map((l) => l.cuenta),
    lineas,
  };
}

/** `BalanzaComprobacion.validar_cuadratura` — `True` si suma(debe) ==
 * suma(haber). */
export function validarCuadratura(lineas: readonly LineaBalanza[]): boolean {
  const totalDebe = lineas.reduce((acc, l) => acc + toDec(l.debe), 0);
  const totalHaber = lineas.reduce((acc, l) => acc + toDec(l.haber), 0);
  return r2(totalDebe) === r2(totalHaber);
}

/** `BalanzaComprobacion.detectar_saldos_anomalos` — cuentas cuyo saldo final
 * contradice su naturaleza (deudora con saldo negativo, o acreedora con
 * saldo negativo), por encima de `umbral`. */
export function detectarSaldosAnomalos(lineas: readonly LineaBalanza[], umbral = 0.01): readonly LineaBalanzaAnomala[] {
  const anomalos: LineaBalanzaAnomala[] = [];
  for (const l of lineas) {
    const saldoFin = toDec(l.saldoFinal);
    if (l.naturaleza === "D" && saldoFin < -umbral) {
      anomalos.push({ ...l, razon: "saldo deudor negativo" });
    } else if (l.naturaleza === "A" && saldoFin < -umbral) {
      anomalos.push({ ...l, razon: "saldo acreedor negativo" });
    }
  }
  return anomalos;
}

/** `N` = envío normal, `C` = complementaria (patrón `[NC]` del XSD; el `B` del generador heredado NO existe en el XSD 1.3). */
export type TipoEnvioBalanza = "N" | "C";

export interface OpcionesXmlBalanza {
  readonly rfc: string;
  readonly ejercicio: number;
  readonly mes: number;
  /** Default `N` (normal). */
  readonly tipoEnvio?: TipoEnvioBalanza;
  /** `FechaModBal` (YYYY-MM-DD): fecha de la última modificación de la balanza. SOLO con `TipoEnvio="C"` (obligatoria entonces); con `N` no se emite. */
  readonly fechaModBal?: string;
}

const FECHA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const IMPORTE_RE = /^-?\d+\.\d{2}$/;

function fechaModBalValida(valor: string): boolean {
  const m = FECHA_RE.exec(valor);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2015) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Balanza de comprobación conforme a `BalanzaComprobacion_1_3.xsd` (validada en las pruebas contra el XSD oficial). Estructura: la raíz
 * `Balanza` contiene una secuencia de nodos `Ctas` (uno por cuenta) con NumCta, SaldoIni, Debe, Haber y SaldoFin (importes con 2 decimales).
 *
 * Decisiones documentadas:
 *  - TipoEnvio es `N`/`C` (no `B`). `FechaModBal` solo va con `C`, y entonces es obligatoria.
 *  - NO hay `FechaModificacion` (no existe en el XSD 1.3). Sello/noCertificado/Certificado son opcionales y se omiten (los llena la e.firma,
 *    que esta aplicación no usa).
 *  - Los saldos iniciales vienen en cada línea (`saldoInicial`), con el signo y la naturaleza de la cuenta.
 */
export function generarXmlBalanza(lineas: readonly LineaBalanza[], opciones: OpcionesXmlBalanza): string {
  const rfc = exigirRfcSat(opciones.rfc);
  exigirEjercicioYMes(opciones.ejercicio, opciones.mes, 13);
  const tipoEnvio = opciones.tipoEnvio ?? "N";
  if (tipoEnvio !== "N" && tipoEnvio !== "C") throw new ContabilidadElectronicaDatosInvalidosError("TipoEnvio de la balanza: N (normal) o C (complementaria).");
  if (tipoEnvio === "C") {
    if (!opciones.fechaModBal || !fechaModBalValida(opciones.fechaModBal)) throw new ContabilidadElectronicaDatosInvalidosError("Una balanza complementaria (C) requiere FechaModBal (AAAA-MM-DD, desde 2015).");
  } else if (opciones.fechaModBal !== undefined) {
    throw new ContabilidadElectronicaDatosInvalidosError("FechaModBal solo se declara en una balanza complementaria (C).");
  }
  if (lineas.length === 0) throw new ContabilidadElectronicaDatosInvalidosError("La balanza no tiene cuentas con saldo ni movimientos: no hay nada que declarar.");
  const esc = escaparAtributoXml;
  for (const l of lineas) {
    for (const [campo, valor] of [["SaldoIni", l.saldoInicial], ["Debe", l.debe], ["Haber", l.haber], ["SaldoFin", l.saldoFinal]] as const) {
      if (!IMPORTE_RE.test(valor)) throw new ContabilidadElectronicaDatosInvalidosError(`Cuenta ${l.cuenta}: ${campo} no es un importe con 2 decimales.`);
    }
  }

  const ctas = lineas.map((l) => `  <BCE:Ctas NumCta="${esc(l.cuenta)}" SaldoIni="${l.saldoInicial}" Debe="${l.debe}" Haber="${l.haber}" SaldoFin="${l.saldoFinal}"/>`).join("\n");
  const fechaMod = tipoEnvio === "C" ? ` FechaModBal="${esc(opciones.fechaModBal as string)}"` : "";

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<BCE:Balanza xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion ' +
    'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd" ' +
    `Version="1.3" RFC="${esc(rfc)}" Mes="${mesDosDigitos(opciones.mes)}" Anio="${opciones.ejercicio}" TipoEnvio="${tipoEnvio}"${fechaMod}>\n` +
    `${ctas}\n` +
    "</BCE:Balanza>\n"
  );
}
