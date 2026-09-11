// Cotización determinista de una estadía en reserva directa — port literal de
// rentas/packages/domain/src/pricing/cotizacion.ts, salvo `evaluarViolacionesMinStay`
// que reemplaza `Temporal.PlainDate.dayOfWeek` por `diaDeLaSemana` (../fechas.ts,
// Date.UTC puro — corrección de diseño Fase 1 §1-#8, sin @js-temporal/polyfill).
// Puramente aditiva noche a noche (precio base o temporada) + un único descuento por
// duración (el de mayor umbral de noches que se cumpla, sin acumular varios) + markup
// de canal opcional. Nunca usa aritmética de punto flotante (../finanzas/redondeo.ts).
import { aplicarPorcentaje, restarCentavos, sumarCentavos } from "../finanzas/redondeo.ts";
import { diaDeLaSemana, nochesDelRango, rangoCubreNoche } from "../fechas.ts";
import type { DesgloseNoche, EntradaCotizacion, ReglaMinStay, ResultadoCotizacion, ViolacionMinStay } from "./tipos.ts";

export function calcularCotizacion(entrada: EntradaCotizacion): ResultadoCotizacion {
  const { contexto, rango, reglaCanal } = entrada;
  const noches = nochesDelRango(rango);
  if (noches.length === 0) {
    throw new Error("El rango de cotización no cubre ninguna noche");
  }

  const desgloseNoches: DesgloseNoche[] = noches.map((fecha) => {
    const temporada = contexto.temporadas.find((t) => rangoCubreNoche(t.rango, fecha));
    if (temporada) {
      return { fecha, precioCentavos: temporada.precioNocheCentavos, origen: "temporada" as const, temporadaNombre: temporada.nombre };
    }
    return { fecha, precioCentavos: contexto.precioBaseNocheCentavos, origen: "base" as const };
  });

  const subtotalAntesDescuentoCentavos = sumarCentavos(...desgloseNoches.map((n) => n.precioCentavos));

  // Descuento por duración: el umbral de noches mínimas más alto que se cumpla,
  // nunca acumulado con otros.
  const descuentoElegible = [...contexto.descuentosDuracion].filter((d) => noches.length >= d.nochesMinimas).sort((a, b) => b.nochesMinimas - a.nochesMinimas)[0];

  const descuentoMontoCentavos = descuentoElegible ? aplicarPorcentaje(subtotalAntesDescuentoCentavos, descuentoElegible.porcentajeDescuentoBasisPoints) : 0;

  const subtotalConDescuentoCentavos = restarCentavos(subtotalAntesDescuentoCentavos, descuentoMontoCentavos);

  const markupCanalCentavos = reglaCanal && reglaCanal.activo ? aplicarPorcentaje(subtotalConDescuentoCentavos, reglaCanal.markupBasisPoints) : 0;

  const totalCentavos = sumarCentavos(subtotalConDescuentoCentavos, markupCanalCentavos);

  const violacionesMinStay = evaluarViolacionesMinStay(contexto.reglasMinStay, rango, noches.length);

  return {
    unidadId: contexto.unidadId,
    moneda: contexto.moneda,
    noches: noches.length,
    desgloseNoches,
    subtotalAntesDescuentoCentavos,
    descuentoAplicado: descuentoElegible
      ? {
          nochesMinimas: descuentoElegible.nochesMinimas,
          porcentajeDescuentoBasisPoints: descuentoElegible.porcentajeDescuentoBasisPoints,
          fuente: descuentoElegible.fuente,
          montoCentavos: descuentoMontoCentavos,
        }
      : null,
    subtotalConDescuentoCentavos,
    markupCanalCentavos,
    totalCentavos,
    violacionesMinStay,
  };
}

/**
 * Min-stay dinámico por fecha de check-in y día de la semana. Solo evalúa reglas cuyo
 * rango cubre la fecha de check-in de la cotización — nunca informativo para fechas
 * fuera del rango solicitado.
 */
export function evaluarViolacionesMinStay(reglas: ReglaMinStay[], rango: { inicio: string; fin: string }, nochesSolicitadas: number): ViolacionMinStay[] {
  const diaSemanaCheckIn = diaDeLaSemana(rango.inicio); // 0=domingo..6=sábado

  return reglas
    .filter((r) => rangoCubreNoche(r.rango, rango.inicio))
    .filter((r) => r.diaSemanaCheckIn === null || r.diaSemanaCheckIn === diaSemanaCheckIn)
    .filter((r) => nochesSolicitadas < r.nochesMinimas)
    .map((regla) => ({ regla, nochesSolicitadas }));
}
