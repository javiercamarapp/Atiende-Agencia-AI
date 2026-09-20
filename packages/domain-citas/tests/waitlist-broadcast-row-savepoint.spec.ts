// f2-citas-whatsapp-config-sesion-sistema (hallazgo adicional) —
// `runListaEsperaCore` (broadcast MANUAL del staff, ejecutado POST-COMMIT en
// sesión de SISTEMA vía `admin.ts::runCitasListaEsperaBroadcastAfterCommit`)
// recorría los candidatos del broadcast SIN aislar cada iteración con
// SAVEPOINT: un error real de Postgres en el `claim`/`enqueue` de un candidato
// a mitad de la corrida dejaba la transacción de sistema COMPLETA abortada
// (25P02) -- el `COMMIT` implícito de `withAppSession` sobre esa transacción
// abortada revierte, en silencio, los `claim`/`enqueue` de TODOS los
// candidatos ANTERIORES de esa misma corrida que sí habían tenido éxito
// (mismo mecanismo real que ya se corrigió para `runConfirmacionCitaCore`,
// auditoría a3, hallazgo confirmado #7).
//
// Mismo patrón EXACTO que `waitlist-cancelar-savepoint.spec.ts` de este mismo
// directorio: `AbortAwareFakeSession` + `PostgresCitasRepository` real (el
// único repositorio que de verdad ejecuta SAVEPOINT/ROLLBACK TO SAVEPOINT --
// `InMemoryCitasRepository` no tiene transacción real que aislar, por eso
// `reminders.spec.ts` nunca hubiera visto este defecto).
//
// Este test FALLABA contra el `runListaEsperaCore` anterior a este fix (loop
// sin `repo.runWithRowSavepoint`): el segundo candidato (venenoso) dejaba la
// sesión abortada, la excepción escapaba del loop sin que el PRIMER candidato
// (ya notificado con éxito) quedara protegido -- la aserción
// `expectSessionRecovered` reventaría con 25P02 en la consulta posterior, y
// `summary.notified` nunca llegaría a contar al primero de forma segura.
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { runListaEsperaCore } from "../src/reminders.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-0000-0000-0000000000w1";
const WAITLIST_OK_ID = "00000000-0000-0000-0000-0000000000w2";
const WAITLIST_POISONED_ID = "00000000-0000-0000-0000-0000000000w3";

function candidateRow(id: string, phone: string, createdAt: string) {
  return {
    out_id: id,
    out_customer_phone: phone,
    out_customer_name: "Candidato",
    out_notified_count: 0,
    out_provider_id: null,
    out_service_id: null,
    out_preferred_date_from: null,
    out_preferred_date_to: null,
    out_preferred_time_window: "any" as const,
    out_created_at: createdAt,
  };
}

function pgDeadlockDetected(): Error & { code: string } {
  const err = new Error("deadlock detected") as Error & { code: string };
  err.code = "40P01";
  return err;
}

async function expectSessionRecovered(session: AbortAwareFakeSession): Promise<void> {
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
}

describe("runListaEsperaCore — aislamiento por fila (hallazgo adicional f2-citas-whatsapp-config-sesion-sistema)", () => {
  it("un error real de Postgres en el SEGUNDO candidato (claim_waitlist_notification_slot) NO revierte el aviso ya encolado del PRIMERO -- aislado por SAVEPOINT, la corrida sigue y reporta el candidato venenoso", async () => {
    let claimCallCount = 0;
    const session = new AbortAwareFakeSession([
      {
        match: /citas\.system_load_live_waitlist_candidates/,
        respond: () => [candidateRow(WAITLIST_OK_ID, "5215500000001", "2026-09-01T09:00:00.000Z"), candidateRow(WAITLIST_POISONED_ID, "5215500000002", "2026-09-01T10:00:00.000Z")],
      },
      { match: /citas\.system_resolve_active_whatsapp_phone_number_id/, respond: () => [{ system_resolve_active_whatsapp_phone_number_id: "phone-1" }] },
      { match: /from core\.organization/, respond: () => [{ id: ORG_ID, name: "Negocio de prueba" }] },
      {
        match: /citas\.claim_waitlist_notification_slot/,
        respond: () => {
          claimCallCount += 1;
          // Primer candidato (FIFO, el más viejo): claim real exitoso.
          if (claimCallCount === 1) return [{ id: WAITLIST_OK_ID }];
          // Segundo candidato: error REAL de Postgres (deadlock), nunca un
          // rechazo de negocio (eso sería `id: null`, "ya en su tope").
          return pgDeadlockDetected();
        },
      },
      { match: /citas\.enqueue_messaging_outbox/, respond: () => [] },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const summary = await runListaEsperaCore(repo, ORG_ID, {}, 5);

    // El candidato venenoso queda reportado (aislado, nunca en silencio) --
    // pero NUNCA tumba la corrida ni se cuenta como notificado.
    expect(summary.failedWaitlistIds).toEqual([WAITLIST_POISONED_ID]);
    // El primer candidato SÍ se notificó de verdad -- lo que el SAVEPOINT
    // protege: sin él, el error del segundo revertiría también este claim/
    // enqueue ya exitoso en la MISMA sesión de sistema post-commit.
    expect(summary.notified).toBe(1);
    expect(summary.candidatesConsidered).toBe(2);

    // La sesión de sistema (compartida por TODA la corrida del broadcast)
    // sigue utilizable después del candidato venenoso -- nunca 25P02
    // permanente, exactamente lo que evita perder a los candidatos anteriores
    // de esta misma corrida.
    await expectSessionRecovered(session);
  });
});
