// Corrección post-revisión de f2-citas-lista-de-espera — revisor independiente
// señaló que, incluso con la migración 020 aplicada, `runOptimizadorCore`/
// `runListaEsperaCore` (sesión de sistema) seguían sin poder mandar ningún
// aviso: el paso INMEDIATO siguiente (resolver `phone_number_id`) llamaba
// `resolveActiveWhatsAppPhoneNumberId`, un SELECT plano contra
// `citas.whatsapp_config` -- esa tabla también solo tiene policy de RLS de
// staff (003_waitlist_and_rate_limit.sql), así que devuelve 0 filas bajo
// sesión de sistema. `PostgresCitasRepository.resolveActiveWhatsAppPhoneNumberIdAsSystem`
// (ver el comentario largo del método en `../src/postgres-repository.ts` y de
// la migración `021_whatsapp_config_sistema_lectura.sql`) reemplaza ese SELECT
// plano por la RPC `security definer` de solo-sistema
// `citas.system_resolve_active_whatsapp_phone_number_id`. Mismo mecanismo
// SAVEPOINT/SQLSTATE que `postgres-repository-waitlist-system-savepoint.spec.ts`
// (020) -- este archivo cubre, con `AbortAwareFakeSession`:
//   1. Camino feliz -- devuelve el phone_number_id real de la RPC.
//   2. Ningún phone_number_id activo -- la RPC devuelve NULL de verdad (no
//      hay fila con is_active=true), no un error -- se propaga tal cual.
//   3. Compatibilidad con la base sin migrar (regla dura del repo): la RPC
//      todavía no existe (SQLSTATE 42883, migración 021 pendiente) ->
//      `runWithSavepointFallback` + `isUndefinedFunctionError` degradan a
//      `null` -- NUNCA deja la sesión compartida abortada para lo que el
//      caller haga después.
//   4. Un error de Postgres DISTINTO a 42883 nunca se enmascara.
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-0000-0000-0000000000c3";

function undefinedFunctionError(): Error & { code: string } {
  const err = new Error("function citas.system_resolve_active_whatsapp_phone_number_id(uuid) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

describe("PostgresCitasRepository.resolveActiveWhatsAppPhoneNumberIdAsSystem", () => {
  it("camino feliz: devuelve el phone_number_id real de citas.system_resolve_active_whatsapp_phone_number_id", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_resolve_active_whatsapp_phone_number_id/, respond: () => [{ system_resolve_active_whatsapp_phone_number_id: "phone-real-1" }] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(ORG_ID);

    expect(phoneNumberId).toBe("phone-real-1");
    // Camino feliz: SAVEPOINT de aislamiento, sin ROLLBACK TO (nunca hizo falta
    // recuperar nada).
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(false);
  });

  it("sin phone_number_id activo: la RPC devuelve NULL de verdad (nunca un error) -- se propaga tal cual, nunca se confunde con el fallback de compatibilidad", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.system_resolve_active_whatsapp_phone_number_id/, respond: () => [{ system_resolve_active_whatsapp_phone_number_id: null }] }]);
    const repo = new PostgresCitasRepository(session);

    const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(ORG_ID);

    expect(phoneNumberId).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(false);
  });

  it("REGLA DURA de compatibilidad: la RPC todavía no existe (SQLSTATE 42883, migración 021 pendiente) -- degrada a null, la sesión compartida queda utilizable después (nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_resolve_active_whatsapp_phone_number_id/, respond: () => undefinedFunctionError() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(ORG_ID);

    expect(phoneNumberId).toBeNull();
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    // La transacción/sesión del caller (p. ej. la sesión de sistema del
    // broadcast post-commit) sigue sirviendo consultas normales -- exactamente
    // lo que en producción evita un `AbortedTransactionCommitError`/un 500 nuevo.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("un error de Postgres DISTINTO a 42883 (ej. 42501, permission denied real) NUNCA se enmascara -- se repropaga tal cual, con la sesión ya recuperada por el SAVEPOINT", async () => {
    const err = new Error("permission denied for function system_resolve_active_whatsapp_phone_number_id") as Error & { code: string };
    err.code = "42501";
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_resolve_active_whatsapp_phone_number_id/, respond: () => err },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    await expect(repo.resolveActiveWhatsAppPhoneNumberIdAsSystem(ORG_ID)).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
