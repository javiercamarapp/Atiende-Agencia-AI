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
//
// Fase 6b (flujos de sistema, migrations/023_night_audit_sistema_escritura.sql):
// `runNoShowSweep` es código COMPARTIDO -- lo invoca tanto `night-audit.ts` bajo
// `withAppSession({ userId: null })` (sesión de sistema, sin `auth.uid()`) COMO
// `POST /hoteles/:propertyId/reservas/procesar-no-show` (staff autenticado real, ver
// `reservas.ts:410`). Verificado contra Postgres real: `findDueNoShowReservations`/
// `transitionReservation`/`releaseAvailability`/`loadTaxConfig`/`ensurePrimaryFolio`/
// `insertCharge` (usados por el camino de abajo) están TODOS bloqueados bajo sesión de
// sistema (policies de staff, sin escape hatch -- `hoteles.reservation`/`folio`/
// `charge` son tablas de dinero/PII, no se les abre una policy nueva). El parámetro
// `session` decide, en tiempo de ejecución, cuál de los 2 caminos correr:
//   * "staff" -- LITERAL el código de antes de este PR, sin ningún cambio (mismos
//     métodos, mismo orden, misma policy).
//   * "sistema" -- usa los 3 métodos `systemXxx` nuevos (migrations/023), cableados
//     SOLO desde `night-audit.ts` cuando corre bajo la ruta interna gateada por
//     secreto.
// Ver el header de esa migración para el análisis completo de por qué
// `evaluateNoShowPenaltyBase` puede calcularse ANTES de reclamar la reserva (los 3
// campos que necesita -- totalAmount/checkInDate/checkOutDate -- no cambian con la
// transición), lo que permite que `systemApplyNoShow` haga "transición + liberación +
// folio + penalización" en una sola llamada atómica.
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
  /** "staff" -- disparo manual autenticado (`POST .../reservas/procesar-no-show`),
   *  usa los métodos ORIGINALES del repositorio, SIN NINGÚN CAMBIO de comportamiento
   *  respecto a antes de esta migración. "sistema" -- barrido interno gateado por
   *  secreto (invocado desde `night-audit.ts`), usa los métodos `systemXxx` nuevos
   *  (migrations/023). Requerido explícito (sin default) para que ningún caller nuevo
   *  olvide declarar cuál camino le corresponde -- ver el comentario de cabecera de
   *  este archivo. */
  readonly session: "staff" | "sistema";
}

/**
 * Reclamo atómico por reserva: una carrera perdida (otra corrida ya la reclamó, o
 * cambió de estado entre la consulta y este punto) se salta sin reintento ni error --
 * nunca se vuelve a postear la penalización de la misma reserva. La transición
 * resultante se atribuye SIEMPRE al actor lógico "system" (`actorUserId: null` en el
 * camino de staff; `set_config('hoteles.actor_user_id', '', true)` dentro de
 * `hoteles.system_apply_no_show` en el camino de sistema -- mismo valor NULL en la
 * bitácora en ambos casos), nunca a quien disparó el job.
 */
export async function runNoShowSweep(repo: HotelesRepository, params: RunNoShowSweepParams): Promise<NoShowSweepResult[]> {
  return params.session === "sistema" ? runNoShowSweepSystem(repo, params) : runNoShowSweepStaff(repo, params);
}

/** Camino de STAFF -- LITERAL, sin ningún cambio de comportamiento respecto a antes de
 *  Fase 6b: mismos 4 pasos separados (transitionReservation/releaseAvailability/
 *  loadTaxConfig/ensurePrimaryFolio/insertCharge), mismos métodos, mismas policies. */
async function runNoShowSweepStaff(repo: HotelesRepository, params: RunNoShowSweepParams): Promise<NoShowSweepResult[]> {
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

/** Camino de SISTEMA (migrations/023) -- TypeScript sigue calculando la penalización
 *  con las MISMAS funciones puras de arriba, usando los campos ya disponibles en la
 *  candidata (nunca cambian por la transición) -- `systemApplyNoShow` hace
 *  transición + liberación de disponibilidad + folio + cargo en una sola llamada
 *  atómica; `null` (carrera perdida) se salta sin reintento ni error, mismo criterio
 *  exacto que el camino de staff. */
async function runNoShowSweepSystem(repo: HotelesRepository, params: RunNoShowSweepParams): Promise<NoShowSweepResult[]> {
  const candidatas = await repo.systemFindDueNoShowReservations(params.propertyId, params.asOfDate);
  const procesadas: NoShowSweepResult[] = [];

  for (const candidata of candidatas) {
    const taxConfig = await repo.systemLoadTaxConfig(params.propertyId);
    const netAmount = evaluateNoShowPenaltyBase(candidata);
    const calc = computeNoShowPenaltyAmounts({ netAmount, taxConfig });

    const applied = await repo.systemApplyNoShow({
      organizationId: params.organizationId,
      propertyId: params.propertyId,
      reservationId: candidata.reservationId,
      netAmount: calc.netAmount,
      taxAmount: calc.taxAmount,
    });
    if (!applied) continue; // carrera perdida -- la reserva ya no estaba en 'confirmada'.

    procesadas.push({
      reservationId: candidata.reservationId,
      folioId: applied.folioId,
      penalizacionNeta: calc.netAmount,
      penalizacionImpuesto: calc.taxAmount,
    });
  }

  return procesadas;
}
