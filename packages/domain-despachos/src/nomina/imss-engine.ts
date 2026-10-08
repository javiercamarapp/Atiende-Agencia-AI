// MOTOR IMSS / INFONAVIT POR RAMA (LSS arts. 25-168, Ley INFONAVIT art. 29-II), tasas 2026 de parametros.ts, TODAS por
// validar con fiscalista. Reemplaza las tasas planas 1.25 % / 14.25 % de la versión anterior, que ocultaban las ramas
// y usaban el salario diario como SBC. Puro: la UMA sale de la vigencia de la fecha de pago, nunca del reloj.
//
// Convenciones:
//  - El SBC se topa a 25 UMA (LSS 28) y debe ser > 0; SBC <= 0 lanza ImssInvalidoError (la versión anterior producía IMSS
//    negativo o cero sin aviso).
//  - Excedente de EyM: sobre (SBC − 3 UMA), solo si el SBC supera 3 UMA.
//  - Cuota fija patronal: 20.40 % de la UMA diaria (no del SBC).
//  - CEAV patronal progresiva por SBC expresado en UMA (CEAV_PATRONAL_2026).
//  - `patronalImss` incluye retiro y CEAV y EXCLUYE INFONAVIT, que se reporta aparte (aportación patronal que no se
//    descuenta al trabajador).
import { r2 } from "./redondeo.ts";
import { IMSS_2026, SBC_MAX_UMA, tasaCeavPatronal, umaVigente } from "./parametros.ts";

export { SBC_MAX_UMA };

export class ImssInvalidoError extends Error {}

export const UMA_DIARIA_2026 = 117.31;
export const UMA_MENSUAL_2026 = 3566.22;

export interface ImssObreroRamas {
  readonly eymExcedente: number;
  readonly prestacionesDinero: number;
  readonly gmp: number;
  readonly invalidezVida: number;
  readonly ceav: number;
  readonly total: number;
}

export interface ImssPatronalRamas {
  readonly cuotaFija: number;
  readonly eymExcedente: number;
  readonly prestacionesDinero: number;
  readonly gmp: number;
  readonly invalidezVida: number;
  readonly riesgoTrabajo: number;
  readonly guarderias: number;
  readonly retiro: number;
  readonly ceav: number;
  /** Suma de las ramas anteriores (sin INFONAVIT). */
  readonly total: number;
}

export interface ImssDesglose {
  readonly umaDiaria: number;
  readonly sbcDiario: number;
  readonly sbcTopado: boolean;
  readonly diasPagados: number;
  readonly obrero: ImssObreroRamas;
  readonly patronal: ImssPatronalRamas;
  readonly infonavit: number;
}

export interface OpcionesImss {
  readonly sbcDiario: number;
  readonly diasPagados: number;
  /** YYYY-MM-DD, define la UMA. */
  readonly fechaPago: string;
  /** Prima de riesgo de trabajo de la empresa (fracción, p. ej. 0.0054355). Por omisión clase I. */
  readonly primaRt?: number;
}

export function sbcDiarioTopado(sbcDiario: number, umaDiaria: number, topeUma: number = SBC_MAX_UMA): number {
  return Math.min(sbcDiario, umaDiaria * topeUma);
}

export function calcularImssPorRama(o: OpcionesImss): ImssDesglose {
  if (!Number.isFinite(o.sbcDiario) || o.sbcDiario <= 0) throw new ImssInvalidoError("El SBC diario debe ser mayor a 0.");
  if (!Number.isFinite(o.diasPagados) || o.diasPagados <= 0) throw new ImssInvalidoError("Los días pagados deben ser mayores a 0.");
  const prima = o.primaRt ?? IMSS_2026.primaRtPorOmision;
  if (!(prima >= 0.005 && prima <= 0.15)) throw new ImssInvalidoError("La prima de riesgo de trabajo debe estar entre 0.5 % y 15 % (LSS 73).");
  const uma = umaVigente(o.fechaPago).diaria;
  const sbc = sbcDiarioTopado(o.sbcDiario, uma);
  const dias = o.diasPagados;
  const base = sbc * dias;
  const exced = Math.max(0, sbc - 3 * uma) * dias;
  const ob = IMSS_2026.obrero;
  const pa = IMSS_2026.patronal;

  const obrero = {
    eymExcedente: r2(exced * ob.eymExcedente),
    prestacionesDinero: r2(base * ob.prestacionesDinero),
    gmp: r2(base * ob.gmp),
    invalidezVida: r2(base * ob.invalidezVida),
    ceav: r2(base * ob.ceav),
  };
  const patronalSinTotal = {
    cuotaFija: r2(uma * dias * pa.cuotaFijaUma),
    eymExcedente: r2(exced * pa.eymExcedente),
    prestacionesDinero: r2(base * pa.prestacionesDinero),
    gmp: r2(base * pa.gmp),
    invalidezVida: r2(base * pa.invalidezVida),
    riesgoTrabajo: r2(base * prima),
    guarderias: r2(base * pa.guarderias),
    retiro: r2(base * pa.retiro),
    ceav: r2(base * tasaCeavPatronal(sbc / uma)),
  };
  return {
    umaDiaria: uma,
    sbcDiario: r2(sbc),
    sbcTopado: o.sbcDiario > sbc,
    diasPagados: dias,
    obrero: { ...obrero, total: r2(Object.values(obrero).reduce((a, b) => a + b, 0)) },
    patronal: { ...patronalSinTotal, total: r2(Object.values(patronalSinTotal).reduce((a, b) => a + b, 0)) },
    infonavit: r2(base * pa.infonavit),
  };
}
