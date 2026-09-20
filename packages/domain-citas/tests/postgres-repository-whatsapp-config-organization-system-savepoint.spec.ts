// f2-citas-whatsapp-config-sesion-sistema — el webhook entrante de WhatsApp de
// citas (`apps/api/.../citas/whatsapp.ts`) abre su PROPIA sesión de SISTEMA
// (`deps.engine.withAppSession({ userId: null }, ...)`, sin `authMiddleware`/JWT
// -- Meta no manda ningún usuario autenticado) y llamaba
// `resolveOrganizationByPhoneNumberId`, un SELECT plano contra
// `citas.whatsapp_config` -- esa tabla (003_waitlist_and_rate_limit.sql) solo
// tiene policy de RLS de STAFF, así que devuelve 0 filas bajo sesión de sistema:
// ningún mensaje entrante de WhatsApp de citas resolvía jamás una organización
// contra Postgres real. `PostgresCitasRepository.resolveOrganizationByPhoneNumberIdAsSystem`
// (ver el comentario largo del método en `../src/postgres-repository.ts` y de la
// migración `022_whatsapp_config_organizacion_sistema_lectura.sql`) reemplaza ese
// SELECT plano por la RPC `security definer` de solo-sistema
// `citas.system_resolve_organization_by_whatsapp_phone_number_id`. Mismo
// mecanismo SAVEPOINT/SQLSTATE que
// `postgres-repository-whatsapp-config-system-savepoint.spec.ts` (021) -- este
// archivo cubre, con `AbortAwareFakeSession`:
//   1. Camino feliz -- devuelve el organization_id real de la RPC.
//   2. Número desconocido -- la RPC devuelve NULL de verdad (no hay fila con
//      ese phone_number_id, o is_active=false), no un error -- se propaga tal
//      cual.
//   3. Compatibilidad con la base sin migrar (regla dura del repo): la RPC
//      todavía no existe (SQLSTATE 42883, migración 022 pendiente) ->
//      `runWithSavepointFallback` + `isUndefinedFunctionError` degradan a
//      `null` -- NUNCA deja la sesión compartida abortada para lo que el
//      caller haga después (el resto del webhook: extraer mensajes, procesar
//      cada uno, etc.).
//   4. Un error de Postgres DISTINTO a 42883 nunca se enmascara.
import { describe, expect, it } from "vitest";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const PHONE_NUMBER_ID = "1234567890";

function undefinedFunctionError(): Error & { code: string } {
  const err = new Error("function citas.system_resolve_organization_by_whatsapp_phone_number_id(text) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

describe("PostgresCitasRepository.resolveOrganizationByPhoneNumberIdAsSystem", () => {
  it("camino feliz: devuelve el organization_id real de citas.system_resolve_organization_by_whatsapp_phone_number_id", async () => {
    const orgId = "00000000-0000-0000-0000-0000000000d1";
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_resolve_organization_by_whatsapp_phone_number_id/, respond: () => [{ system_resolve_organization_by_whatsapp_phone_number_id: orgId }] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const organizationId = await repo.resolveOrganizationByPhoneNumberIdAsSystem(PHONE_NUMBER_ID);

    expect(organizationId).toBe(orgId);
    // Camino feliz: SAVEPOINT de aislamiento, sin ROLLBACK TO (nunca hizo falta
    // recuperar nada).
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(false);
  });

  it("número desconocido en la plataforma: la RPC devuelve NULL de verdad (nunca un error) -- se propaga tal cual, nunca se confunde con el fallback de compatibilidad", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_resolve_organization_by_whatsapp_phone_number_id/, respond: () => [{ system_resolve_organization_by_whatsapp_phone_number_id: null }] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const organizationId = await repo.resolveOrganizationByPhoneNumberIdAsSystem(PHONE_NUMBER_ID);

    expect(organizationId).toBeNull();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(false);
  });

  it("REGLA DURA de compatibilidad: la RPC todavía no existe (SQLSTATE 42883, migración 022 pendiente) -- degrada a null, la sesión compartida del webhook queda utilizable después (nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_resolve_organization_by_whatsapp_phone_number_id/, respond: () => undefinedFunctionError() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const organizationId = await repo.resolveOrganizationByPhoneNumberIdAsSystem(PHONE_NUMBER_ID);

    expect(organizationId).toBeNull();
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    // La sesión de sistema del webhook (compartida con el resto del request --
    // extraer mensajes, procesar cada uno, encolar respuestas) sigue sirviendo
    // consultas normales -- exactamente lo que en producción evita un
    // `AbortedTransactionCommitError`/un 500 nuevo para todo el batch de Meta.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("un error de Postgres DISTINTO a 42883 (ej. 42501, permission denied real) NUNCA se enmascara -- se repropaga tal cual, con la sesión ya recuperada por el SAVEPOINT", async () => {
    const err = new Error("permission denied for function system_resolve_organization_by_whatsapp_phone_number_id") as Error & { code: string };
    err.code = "42501";
    const session = new AbortAwareFakeSession([
      { match: /citas\.system_resolve_organization_by_whatsapp_phone_number_id/, respond: () => err },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    await expect(repo.resolveOrganizationByPhoneNumberIdAsSystem(PHONE_NUMBER_ID)).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
