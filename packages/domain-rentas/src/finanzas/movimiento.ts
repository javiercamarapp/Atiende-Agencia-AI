// Calcula el movimiento financiero de UNA reserva — port literal de
// rentas/packages/domain/src/finanzas/movimiento.ts. Punto crítico de diseño
// (Finanzas-1): si el canal ya entrega el monto neto de su comisión (Airbnb
// confirmado), este cálculo NUNCA vuelve a restar la comisión de canal sobre el bruto
// original — parte directamente del monto ya recibido.
import { aplicarPorcentaje, restarCentavos, sumarCentavos } from "./redondeo.ts";
import type { EntradaMovimientoReserva, MovimientoFinancieroReserva } from "./tipos.ts";

export function calcularMovimientoReserva(entrada: EntradaMovimientoReserva): MovimientoFinancieroReserva {
  if (entrada.montoBrutoCentavos < 0) {
    throw new Error("montoBrutoCentavos no puede ser negativo");
  }

  const { comisionCanal } = entrada;
  let comisionCanalCentavos: number;
  let montoRecibidoCentavos: number;

  if (comisionCanal.yaNetoDeComision) {
    // Finanzas-1: no hay doble descuento. El monto de entrada YA es lo que el gestor
    // recibió; la comisión de canal no se resta de nuevo (se reporta en 0, con la
    // fuente documentada para trazabilidad, nunca inventando un bruto anterior que
    // Atiende no puede verificar).
    comisionCanalCentavos = 0;
    montoRecibidoCentavos = entrada.montoBrutoCentavos;
  } else {
    comisionCanalCentavos = aplicarPorcentaje(entrada.montoBrutoCentavos, comisionCanal.comisionBasisPoints);
    montoRecibidoCentavos = restarCentavos(entrada.montoBrutoCentavos, comisionCanalCentavos);
  }

  const baseComisionGestor = entrada.comisionGestor.base === "bruto" ? entrada.montoBrutoCentavos : montoRecibidoCentavos;
  const comisionGestorCentavos = aplicarPorcentaje(baseComisionGestor, entrada.comisionGestor.basisPoints);

  const gastosCentavos = sumarCentavos(...entrada.gastos.map((g) => g.montoCentavos));
  const impuestosCentavos = sumarCentavos(...entrada.impuestos.map((i) => i.montoCentavos));

  const netoCentavos = restarCentavos(montoRecibidoCentavos, comisionGestorCentavos, gastosCentavos, impuestosCentavos);

  return {
    ocupacionUnidadId: entrada.ocupacionUnidadId,
    moneda: entrada.moneda,
    ingresoBrutoCentavos: entrada.montoBrutoCentavos,
    montoRecibidoCentavos,
    comisionCanalCentavos,
    comisionCanalFuente: comisionCanal.fuente,
    comisionGestorCentavos,
    gastosCentavos,
    impuestosCentavos,
    netoCentavos,
  };
}
