// f2-citas-lista-de-espera, hallazgo (A) — `PostgresCitasRepository.
// loadLiveWaitlistCandidatesAsSystem` (ver el comentario largo del método en
// `../src/postgres-repository.ts` y de la migración
// `020_appointment_waitlist_sistema_lectura.sql`) reemplaza el SELECT plano
// contra `citas.appointment_waitlist` (RLS de staff, SIEMPRE 0 filas en sesión
// de sistema) por la RPC `security definer` de solo-sistema
// `citas.system_load_live_waitlist_candidates`. Este archivo cubre, con
// `AbortAwareFakeSession` (reproduce SQLSTATE/estado "aborted" reales, a
// diferencia de `InMemoryCitasRepository`):
//   1. Camino feliz -- mapea las columnas `out_*` reales de la RPC.
//   2. Compatibilidad con la base sin migrar (regla dura del repo): la RPC
//      todavía no existe (SQLSTATE 42883, migración 020 pendiente) ->
//      `runWithSavepointFallback` + `isUndefinedFunctionError` degradan a
//      lista vacía -- NUNCA deja la sesión compartida abortada para lo que el
//      caller haga después (a diferencia de un try/catch simple sin SAVEPOINT,
//      ver `packages/db/src/savepoint-fallback.ts`).
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-0000-0000-0000000000c1";
const WAITLIST_ID = "00000000-0000-0000-0000-0000000000c2";

function undefinedFunctionError(): Error & { code: string } {
  const err = new Error("function citas.system_load_live_waitlist_candidates(uuid) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

describe("PostgresCitasRepository.loadLiveWaitlistCandidatesAsSystem", () => {
  it("camino feliz: mapea las columnas out_* de citas.system_load_live_waitlist_candidates, incluida la fecha como texto", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /citas\.system_load_live_waitlist_candidates/,
        respond: () => [
          {
            out_id: WAITLIST_ID,
            out_customer_phone: "5215500000001",
            out_customer_name: "Candidato",
            out_notified_count: 0,
            out_provider_id: null,
            out_service_id: null,
            out_preferred_date_from: "2026-01-15",
            out_preferred_date_to: null,
            out_preferred_time_window: "any",
            out_created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ]);
    const repo = new PostgresCitasRepository(session);

    const rows = await repo.loadLiveWaitlistCandidatesAsSystem(ORG_ID);

    expect(rows).toEqual([
      {
        id: WAITLIST_ID,
        customerPhone: "5215500000001",
        customerName: "Candidato",
        notifiedCount: 0,
        providerId: null,
        serviceId: null,
        preferredDateFrom: "2026-01-15",
        preferredDateTo: null,
        preferredTimeWindow: "any",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    // Camino feliz: SAVEPOINT de aislamiento, sin ROLLBACK TO (nunca hizo falta
    // recuperar nada).
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(false);
  });

  it("REGLA DURA de compatibilidad: la RPC todavía no existe (SQLSTATE 42883, migración 020 pendiente) -- degrada a lista vacía, la sesión compartida queda utilizable después (nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_load_live_waitlist_candidates/, respond: () => undefinedFunctionError() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const rows = await repo.loadLiveWaitlistCandidatesAsSystem(ORG_ID);

    expect(rows).toEqual([]);
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    // La transacción/sesión del caller (p. ej. la del cancelar de staff, o la
    // sesión de sistema del broadcast post-commit) sigue sirviendo consultas
    // normales -- exactamente lo que en producción evita un
    // `AbortedTransactionCommitError`/un 500 nuevo.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("un error de Postgres DISTINTO a 42883 (ej. 42501, permission denied real) NUNCA se enmascara -- se repropaga tal cual, con la sesión ya recuperada por el SAVEPOINT", async () => {
    const err = new Error("permission denied for function system_load_live_waitlist_candidates") as Error & { code: string };
    err.code = "42501";
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_load_live_waitlist_candidates/, respond: () => err },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    await expect(repo.loadLiveWaitlistCandidatesAsSystem(ORG_ID)).rejects.toMatchObject({ code: "42501" });
    // El SAVEPOINT igual recuperó la sesión antes de repropagar (ver
    // `runWithSavepointFallback`) -- un catch exterior que siga usando la MISMA
    // sesión no la encuentra abortada.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
