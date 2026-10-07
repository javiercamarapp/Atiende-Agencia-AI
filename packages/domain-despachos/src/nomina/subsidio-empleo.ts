// SUBSIDIO PARA EL EMPLEO — vigente desde mayo de 2024 como porcentaje de la UMA mensual (decreto DOF; para 2026,
// DOF 31-dic-2025): 15.59 % × UMA 2025 en enero y 15.02 % × UMA 2026 desde febrero, si el ingreso gravado mensual
// no excede $11,492.66. Los valores viven en parametros.ts (por validar con fiscalista).
//
// REEMPLAZA la tabla escalonada vieja (tope $407.02, portada del sistema suelto), que ya no rige. En periodos no
// mensuales el monto y el tope se prorratean por días del periodo / 30.4 (nunca se compara un ingreso mensual contra
// la tabla quincenal, como hacía la versión anterior y daba 0).
import { r2 } from "./redondeo.ts";
import { DIAS_MES_PRORRATEO, subsidioVigente } from "./parametros.ts";

export type Periodicidad = "mensual" | "quincenal";

export interface OpcionesSubsidio {
  readonly periodicidad?: Periodicidad;
  /** Días del periodo (solo cuentan en periodos no mensuales; por omisión 15 en quincenal). */
  readonly diasPeriodo?: number;
}

/**
 * Subsidio causado del periodo. `ingresoGravadoMensual` está en escala MENSUAL (mismo criterio que el ISR del motor).
 * Mensual: porcentaje × UMA mensual de la vigencia. No mensual: ese monto /30.4 × días del periodo. Sobre el tope
 * mensual o ingreso <= 0 devuelve 0.
 */
export function calcularSubsidio(ingresoGravadoMensual: number, fechaPago: string, opts: OpcionesSubsidio = {}): number {
  if (!(ingresoGravadoMensual > 0)) return 0;
  const v = subsidioVigente(fechaPago);
  if (ingresoGravadoMensual > v.topeIngresoMensual) return 0;
  const mensual = v.porcentajeUma * v.umaMensualBase;
  if ((opts.periodicidad ?? "mensual") === "mensual") return r2(mensual);
  const dias = opts.diasPeriodo ?? 15;
  return r2((mensual / DIAS_MES_PRORRATEO) * dias);
}
