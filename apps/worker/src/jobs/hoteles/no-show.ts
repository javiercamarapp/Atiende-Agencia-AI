// H02/Fase 3 (REQ-RES-008) — job de no-show: toda reserva 'confirmada' cuya fecha de
// check-in ya pasó sin check-in real se marca 'no_show', libera el inventario de
// TODAS sus noches, y postea la penalización (`computeNoShowPenaltyAmounts`,
// IVA sí/ISH no) al folio primario. Extraído ~literal de la lógica que ya vivía
// inline en `apps/api/src/routes/verticals/hoteles/reservas.ts`
// (`POST .../reservas/procesar-no-show`, Fase 3) hacia aquí -- Fase 6 (REQ-REV-013)
// necesita el MISMO comportamiento dentro de `night-audit.ts` ("marca no-shows del
// día", ver comentario de cabecera de ese archivo) y no debía reimplementarlo una
// segunda vez. `reservas.ts` ahora solo invoca esta función; el contrato HTTP de esa
// ruta (`{ procesadas, detalle }`) no cambió.
import { computeNoShowPenaltyAmounts, evaluateNoShowPenaltyBase, nightsBetween, type HotelesRepository } from "@atiende/domain-hoteles";

export interface NoShowSweepResult {
  readonly reservationId: string;
  readonly folioId: string;
  readonly penalizacionNeta: number;
  readonly penalizacionImpuesto: number;
}

export interface RunNoShowSweepParams {
  readonly organizationId: string;
  readonly propertyId: string;
  /** `null` -- usa "hoy" real, mismo criterio que `findDueNoShowReservations`. */
  readonly asOfDate: string | null;
}

/**
 * Reclamo atómico por reserva (`transitionReservation`, ver
 * `HotelesRepository.findDueNoShowReservations`): una carrera perdida (otra corrida
 * ya la reclamó, o cambió de estado entre la consulta y este punto) se salta sin
 * reintento ni error -- nunca se vuelve a postear la penalización de la misma
 * reserva. La transición resultante se atribuye SIEMPRE al actor lógico "system"
 * (`actorUserId: null`), nunca a quien disparó el job.
 */
export async function runNoShowSweep(repo: HotelesRepository, params: RunNoShowSweepParams): Promise<NoShowSweepResult[]> {
  const candidatas = await repo.findDueNoShowReservations(params.propertyId, params.asOfDate);
  const procesadas: NoShowSweepResult[] = [];

  for (const candidata of candidatas) {
    const reclamada = await repo.transitionReservation(params.propertyId, candidata.id, ["confirmada"], "no_show", null);
    if (!reclamada) continue;

    const nights = nightsBetween(reclamada.checkInDate, reclamada.checkOutDate);
    for (const night of nights) {
      await repo.releaseAvailability(params.propertyId, reclamada.roomTypeId, night, 1);
    }

    // §3.4 (Fase 3) resuelto: penalización con `computeNoShowPenaltyAmounts` (IVA
    // sí, ISH no) -- NUNCA `computeChargeAmounts({concept:'hospedaje'})`, que
    // cobraría ISH de más.
    const taxConfig = await repo.loadTaxConfig(params.propertyId);
    const netAmount = evaluateNoShowPenaltyBase(reclamada);
    const calc = computeNoShowPenaltyAmounts({ netAmount, taxConfig });

    const folio = await repo.ensurePrimaryFolio(params.propertyId, params.organizationId, reclamada.id);
    // Sin `stayDate`: evita chocar con el índice único parcial anti-doble-captura del
    // night-audit (`charge_folio_stay_date_hospedaje_idx`), que solo protege cargos
    // de hospedaje CON noche real posteada.
    await repo.insertCharge({
      organizationId: params.organizationId,
      propertyId: params.propertyId,
      folioId: folio.id,
      description: "Penalización por no-show",
      amount: calc.netAmount,
      taxAmount: calc.taxAmount,
      concept: "hospedaje",
      stayDate: null,
    });

    procesadas.push({ reservationId: reclamada.id, folioId: folio.id, penalizacionNeta: calc.netAmount, penalizacionImpuesto: calc.taxAmount });
  }

  return procesadas;
}
