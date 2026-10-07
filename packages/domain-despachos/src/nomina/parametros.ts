// Parámetros de nómina por vigencia (D-P3-02/03/08/09). TODO valor de este archivo está marcado
// "validar con fiscalista" (normas/lss-infonavit.yaml, lisr-113-174.yaml, lisr-93.yaml, lft-76-127.yaml con
// estado por_verificar): NO fusionar sin el visto bueno del fiscalista de Javier.
// Puro: la vigencia se resuelve por la fecha de pago que se pasa explícita; nunca se lee el reloj.

export interface VigenciaUma {
  /** Primer día (YYYY-MM-DD) en que rige esta UMA (cambia cada 1-feb). */
  readonly desde: string;
  readonly diaria: number;
  readonly mensual: number;
}

/** UMA por vigencia. La UMA 2026 rige desde el 1-feb-2026; en enero de 2026 sigue la de 2025. */
export const UMAS: readonly VigenciaUma[] = [
  { desde: "2025-02-01", diaria: 113.14, mensual: 3439.46 },
  { desde: "2026-02-01", diaria: 117.31, mensual: 3566.22 },
];

export interface VigenciaSubsidio {
  readonly desde: string;
  /** Porcentaje de la UMA mensual (decreto DOF 31-dic-2025 para 2026). */
  readonly porcentajeUma: number;
  /** Ingreso gravado mensual máximo para tener derecho al subsidio. */
  readonly topeIngresoMensual: number;
  /** UMA mensual sobre la que se aplica el porcentaje (la vigente en el decreto, no necesariamente la del mes). */
  readonly umaMensualBase: number;
}

/** Subsidio al empleo como % de la UMA mensual (desde mayo 2024). Enero 2026: 15.59 % × UMA 2025; desde feb-2026: 15.02 % × UMA 2026. */
export const SUBSIDIOS: readonly VigenciaSubsidio[] = [
  { desde: "2026-01-01", porcentajeUma: 0.1559, topeIngresoMensual: 11492.66, umaMensualBase: 3439.46 },
  { desde: "2026-02-01", porcentajeUma: 0.1502, topeIngresoMensual: 11492.66, umaMensualBase: 3566.22 },
];

/** Divisor legal de días por mes para prorratear periodos no mensuales (decreto del subsidio / art. 96 LISR). */
export const DIAS_MES_PRORRATEO = 30.4;

/** Primer día cubierto por el motor: antes no hay tarifa ISR ni subsidio cargados. */
export const INICIO_VIGENCIA_MOTOR = "2026-01-01";

export class VigenciaNoSoportadaError extends Error {}

function resolver<T extends { readonly desde: string }>(tabla: readonly T[], fechaPago: string, que: string): T {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPago)) throw new VigenciaNoSoportadaError(`fechaPago "${fechaPago}" no tiene el formato YYYY-MM-DD.`);
  let elegido: T | undefined;
  for (const v of tabla) if (v.desde <= fechaPago) elegido = v;
  if (!elegido) throw new VigenciaNoSoportadaError(`No hay ${que} cargado para la fecha ${fechaPago} (el motor cubre desde ${INICIO_VIGENCIA_MOTOR}).`);
  return elegido;
}

export function umaVigente(fechaPago: string): VigenciaUma {
  return resolver(UMAS, fechaPago, "UMA");
}

export function subsidioVigente(fechaPago: string): VigenciaSubsidio {
  return resolver(SUBSIDIOS, fechaPago, "subsidio al empleo");
}

/** Tope de SBC en UMA (LSS art. 28). */
export const SBC_MAX_UMA = 25;

/** Tasas IMSS 2026 por rama (fracción del SBC salvo indicación). Fuente secundaria: validar con fiscalista. */
export const IMSS_2026 = {
  obrero: {
    eymExcedente: 0.004, // sobre (SBC − 3 UMA)
    prestacionesDinero: 0.0025,
    gmp: 0.00375,
    invalidezVida: 0.00625,
    ceav: 0.01125,
  },
  patronal: {
    cuotaFijaUma: 0.204, // sobre la UMA diaria, no sobre el SBC
    eymExcedente: 0.011, // sobre (SBC − 3 UMA)
    prestacionesDinero: 0.007,
    gmp: 0.0105,
    invalidezVida: 0.0175,
    guarderias: 0.01,
    retiro: 0.02,
    infonavit: 0.05,
  },
  /** Prima de riesgo de trabajo por omisión: clase I (0.54355 %). Es parámetro de la empresa, no constante legal. */
  primaRtPorOmision: 0.0054355,
} as const;

export interface TramoCeav {
  /** Límite superior del tramo en UMA (inclusive); Infinity para el último. */
  readonly hastaUma: number;
  readonly tasa: number;
}

/**
 * CEAV patronal 2026 (cesantía y vejez, art. 168-II LSS, transitorio DOF 16-dic-2020), progresiva por SBC en UMA.
 * El tramo "1 salario mínimo" (3.150 %) se aproxima con el primer tramo por UMA porque el SBC de 1.0 UMA o menos
 * es hoy inferior al mínimo. DISCREPANCIA ENTRE FUENTES SECUNDARIAS en 3.51–4.00 UMA (6.613 % vs 6.94 %): se usa 6.613 %
 * y queda como pregunta explícita al fiscalista.
 */
export const CEAV_PATRONAL_2026: readonly TramoCeav[] = [
  { hastaUma: 1.0, tasa: 0.0315 },
  { hastaUma: 1.5, tasa: 0.03676 },
  { hastaUma: 2.0, tasa: 0.04851 },
  { hastaUma: 2.5, tasa: 0.05556 },
  { hastaUma: 3.0, tasa: 0.06026 },
  { hastaUma: 3.5, tasa: 0.06361 },
  { hastaUma: 4.0, tasa: 0.06613 },
  { hastaUma: Infinity, tasa: 0.07513 },
];

export function tasaCeavPatronal(sbcEnUma: number): number {
  for (const t of CEAV_PATRONAL_2026) if (sbcEnUma <= t.hastaUma) return t.tasa;
  return CEAV_PATRONAL_2026[CEAV_PATRONAL_2026.length - 1]!.tasa;
}

/** Exentos del art. 93 LISR en UMA diarias. */
export const EXENTOS_ART_93 = {
  aguinaldoUma: 30,
  primaVacacionalUma: 15,
  ptuUma: 15,
  /** Tiempo extra (fr. I): 50 % del pago, sin exceder de 5 UMA por semana. */
  tiempoExtraUmaSemana: 5,
  tiempoExtraFraccionExenta: 0.5,
} as const;
