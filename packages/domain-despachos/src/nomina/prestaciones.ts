// PRESTACIONES — LFT arts. 76 (vacaciones), 80 (prima vacacional), 87 (aguinaldo), 117/127 (PTU) y exentos del art. 93
// LISR. Todo por validar con fiscalista (normas/lft-76-127.yaml, lisr-93.yaml). Puro, sin reloj.
import { r2 } from "./redondeo.ts";
import { EXENTOS_ART_93 } from "./parametros.ts";

export function calcularAguinaldo(salarioDiario: number, diasAguinaldo = 15): number {
  return r2(Math.max(0, salarioDiario) * diasAguinaldo);
}

/** Aguinaldo proporcional por días trabajados en el año (LFT 87: parte proporcional si no se completó el año). */
export function calcularAguinaldoProporcional(salarioDiario: number, diasTrabajadosEnAnio: number, diasAguinaldo = 15, diasDelAnio = 365): number {
  const dias = Math.min(Math.max(0, diasTrabajadosEnAnio), diasDelAnio);
  return r2((Math.max(0, salarioDiario) * diasAguinaldo * dias) / diasDelAnio);
}

/**
 * Días de vacaciones por años completos de antigüedad (art. 76 LFT reformado, 2023): 12, 14, 16, 18, 20 en los años
 * 1 a 5; después 22 (6-10), 24 (11-15), 26 (16-20)... +2 cada 5 años. Menos de 1 año completo: 0 (aún no hay derecho).
 */
export function diasVacacionesPorAntiguedad(aniosCompletos: number): number {
  const a = Math.floor(aniosCompletos);
  if (!(a >= 1)) return 0;
  if (a <= 5) return 12 + (a - 1) * 2;
  return 22 + Math.floor((a - 6) / 5) * 2;
}

/** Prima vacacional (LFT 80): 25 % mínimo sobre los días de vacaciones. Por omisión 12 días (mínimo vigente tras la reforma 2023). */
export function calcularPrimaVacacional(salarioDiario: number, diasVacaciones = 12, porcentaje = 0.25): number {
  return r2(Math.max(0, salarioDiario) * diasVacaciones * porcentaje);
}

/** Factor de integración (LSS 27 / LFT): 1 + (aguinaldo + vacaciones × prima) / 365, a 4 decimales. Año 1: 1.0493. */
export function factorIntegracion(aniosCompletos: number, diasAguinaldo = 15, primaVacacional = 0.25): number {
  const vac = Math.max(12, diasVacacionesPorAntiguedad(aniosCompletos));
  return Math.round((1 + (diasAguinaldo + vac * primaVacacional) / 365 + Number.EPSILON) * 10000) / 10000;
}

export interface Exento {
  readonly total: number;
  readonly exento: number;
  readonly gravado: number;
}

function partir(total: number, topeUmas: number, umaDiaria: number): Exento {
  const t = r2(Math.max(0, total));
  const exento = r2(Math.min(t, topeUmas * umaDiaria));
  return { total: t, exento, gravado: r2(t - exento) };
}

export const exentoAguinaldo = (importe: number, umaDiaria: number): Exento => partir(importe, EXENTOS_ART_93.aguinaldoUma, umaDiaria);
export const exentoPrimaVacacional = (importe: number, umaDiaria: number): Exento => partir(importe, EXENTOS_ART_93.primaVacacionalUma, umaDiaria);
export const exentoPtu = (importe: number, umaDiaria: number): Exento => partir(importe, EXENTOS_ART_93.ptuUma, umaDiaria);

/** Tiempo extra (art. 93-I): horas dobles exentas al 50 % sin exceder 5 UMA por semana; las triples son 100 % gravadas. */
export function exentoTiempoExtra(importeDoble: number, importeTriple: number, semanas: number, umaDiaria: number): Exento {
  const d = Math.max(0, importeDoble);
  const tr = Math.max(0, importeTriple);
  const tope = EXENTOS_ART_93.tiempoExtraUmaSemana * umaDiaria * Math.max(1, semanas);
  const exento = r2(Math.min(d * EXENTOS_ART_93.tiempoExtraFraccionExenta, tope));
  const total = r2(d + tr);
  return { total, exento, gravado: r2(total - exento) };
}

export interface ResultadoPtu {
  readonly ptuCalculada: number;
  readonly tope: number;
  readonly topado: boolean;
  /** PTU a pagar al trabajador tras el tope del art. 127-VIII. */
  readonly monto: number;
}

/**
 * PTU del trabajador con el tope del art. 127-VIII LFT: tres meses de salario o el promedio de la PTU recibida en los
 * últimos tres años, lo que sea más favorable al trabajador. `ptuCalculada` ya viene del reparto (art. 117-123).
 */
export function aplicarTopePtu(ptuCalculada: number, salarioDiario: number, ptuUltimosTresAnios: readonly number[] = []): ResultadoPtu {
  const tresMeses = Math.max(0, salarioDiario) * 90;
  const prom = ptuUltimosTresAnios.length > 0 ? ptuUltimosTresAnios.reduce((a, b) => a + b, 0) / ptuUltimosTresAnios.length : 0;
  const tope = r2(Math.max(tresMeses, prom));
  const base = r2(Math.max(0, ptuCalculada));
  return { ptuCalculada: base, tope, topado: base > tope, monto: r2(Math.min(base, tope)) };
}
