// Conciliación de payout de canal (Fase 2, Flujo 6) — port de
// rentas/packages/domain/src/finanzas/conciliacion.ts, alcance recortado (ver diseño
// Fase 2 rentas §1.4/§5): función pura, sin IO, que NUNCA parsea un CSV/XLS real de
// canal — recibe `LineaPayoutEntrada[]` ya normalizadas (por el staff, a mano o desde
// un JSON) y las candidatas de conciliación ya resueltas por el repository
// (reservas de la property con canal de origen = el canal del payout y con
// `reserva_financiero` ya registrado, Flujo 3 de Fase 1).
export type EstadoConciliacion = "conciliado" | "pendiente" | "discrepancia";

/** Una línea del payout tal como el staff la capturó — SIEMPRE ya normalizada (nunca
 * un CSV/XLS crudo de canal, ver diseño §1.4). */
export interface LineaPayoutEntrada {
  readonly referenciaExternaReserva: string | null;
  readonly montoCentavos: number;
}

/** Una reserva candidata a conciliar contra este payout — ya resuelta por
 * `RentasRepository.findCandidatasConciliacion` (canal de origen coincide, tiene
 * `reserva_financiero` registrado). */
export interface CandidataConciliacion {
  readonly ocupacionId: string;
  readonly externalId: string | null;
  readonly montoEsperadoCentavos: number;
}

export interface LineaConciliada {
  readonly ocupacionId: string | null;
  readonly referenciaExternaReserva: string | null;
  readonly montoCentavos: number;
  readonly montoEsperadoCentavos: number | null;
  readonly estado: EstadoConciliacion;
}

export interface ResumenConciliacion {
  readonly conciliadas: number;
  readonly pendientes: number;
  readonly discrepancias: number;
}

export interface ResultadoConciliacion {
  readonly lineas: readonly LineaConciliada[];
  readonly resumen: ResumenConciliacion;
}

/**
 * Matching determinista, en este orden estricto por línea:
 *  1. Por `referenciaExternaReserva` == `externalId` de una candidata no usada aún.
 *  2. Si no hay match de referencia, por monto exacto (`montoCentavos` ==
 *     `montoEsperadoCentavos`) contra una candidata no usada aún.
 *  3. Si ninguna candidata coincide -> `pendiente` (nunca "a ojo").
 * Una candidata encontrada por referencia cuyo monto NO coincide exacto -> `discrepancia`
 * (nunca se fuerza a `conciliado`: el monto importa tanto como la identidad de la
 * reserva). Cada candidata se usa a lo más una vez (una reserva no concilia dos líneas
 * del mismo payout).
 */
export function conciliarPayout(lineas: readonly LineaPayoutEntrada[], candidatas: readonly CandidataConciliacion[]): ResultadoConciliacion {
  const usadas = new Set<string>();

  const resultado: LineaConciliada[] = lineas.map((linea) => {
    const porReferencia =
      linea.referenciaExternaReserva !== null
        ? candidatas.find((c) => !usadas.has(c.ocupacionId) && c.externalId !== null && c.externalId === linea.referenciaExternaReserva)
        : undefined;

    const candidata = porReferencia ?? candidatas.find((c) => !usadas.has(c.ocupacionId) && c.montoEsperadoCentavos === linea.montoCentavos);

    if (!candidata) {
      return { ocupacionId: null, referenciaExternaReserva: linea.referenciaExternaReserva, montoCentavos: linea.montoCentavos, montoEsperadoCentavos: null, estado: "pendiente" };
    }

    usadas.add(candidata.ocupacionId);
    const coincideMonto = candidata.montoEsperadoCentavos === linea.montoCentavos;
    return {
      ocupacionId: candidata.ocupacionId,
      referenciaExternaReserva: linea.referenciaExternaReserva,
      montoCentavos: linea.montoCentavos,
      montoEsperadoCentavos: candidata.montoEsperadoCentavos,
      estado: coincideMonto ? "conciliado" : "discrepancia",
    };
  });

  const resumen: ResumenConciliacion = {
    conciliadas: resultado.filter((l) => l.estado === "conciliado").length,
    pendientes: resultado.filter((l) => l.estado === "pendiente").length,
    discrepancias: resultado.filter((l) => l.estado === "discrepancia").length,
  };

  return { lineas: resultado, resumen };
}
