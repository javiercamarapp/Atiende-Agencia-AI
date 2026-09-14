// Balanza de comprobación mensual — puerto de
// `b2b_ai/services/balanza.py::BalanzaComprobacion` (XSD
// `balanzaComprobacion`, v1.3 del SAT).
//
// Funcional, mismo criterio que `catalogo-cuentas.ts`: sin clase con estado
// mutable (`self.lineas`/`self._asientos`), todo recibido y devuelto
// explícito.
import type { AsientoContable, CuentaAnexo24, LineaBalanza, LineaBalanzaAnomala, NaturalezaCuenta, ResumenBalanza } from "./types.ts";
import { findCuenta } from "./catalogo-cuentas.ts";

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

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export type TipoEnvioBalanza = "B" | "C";

export interface OpcionesXmlBalanza {
  readonly rfc?: string;
  readonly ejercicio: number;
  readonly mes: number;
  /** "B" = balanza de comprobación, "C" = catálogo de cuentas — default "B"
   * igual que el origen. */
  readonly tipoEnvio?: TipoEnvioBalanza;
  /** "YYYY-MM-DDTHH:MM:SS" — mismo criterio de `catalogo-
   * cuentas.ts::OpcionesXmlCatalogo.fechaModificacion` (DESVIACIÓN
   * DOCUMENTADA: el original defaultea a `datetime.now()`; aquí es
   * obligatorio y explícito). */
  readonly fechaModificacion: string;
}

/** `BalanzaComprobacion.generar_xml` — XML de la balanza de comprobación
 * conforme al XSD del SAT (`BalanzaComprobacion_1_3.xsd`), igual estructura
 * que `b2b_ai/templates/balanza_comprobacion.xml`. */
export function generarXmlBalanza(lineas: readonly LineaBalanza[], opciones: OpcionesXmlBalanza): string {
  const rfc = opciones.rfc ?? "";
  const tipoEnvio = opciones.tipoEnvio ?? "B";
  const mesS = String(opciones.mes).padStart(2, "0");
  const esc = (v: string) => escapeXmlAttr(v);

  const ctas = lineas.map((l) => `      <BCE:Cta NumCta="${esc(l.cuenta)}" SaldoIni="${esc(l.saldoInicial)}" Debe="${esc(l.debe)}" Haber="${esc(l.haber)}" SaldoFin="${esc(l.saldoFinal)}"/>`).join("\n");

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<BCE:Balanza xmlns:BCE="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xsi:schemaLocation="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion ' +
    'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd" ' +
    `Version="1.3" TipoEnvio="${esc(tipoEnvio)}" RFC="${esc(rfc)}" Mes="${mesS}" Anio="${opciones.ejercicio}" ` +
    `FechaModificacion="${esc(opciones.fechaModificacion)}" Sello="" noCertificado="" Certificado="">\n` +
    `  <BCE:Ctas>\n${ctas}\n  </BCE:Ctas>\n` +
    "</BCE:Balanza>\n"
  );
}
