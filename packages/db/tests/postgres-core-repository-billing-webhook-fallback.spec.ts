// Hallazgo de revisión real (PR #153, ronda 1): `recordBillingWebhookEvent`
// (escritura best-effort) y `listBillingWebhookLogForSuperadmin` (lectura con
// "vacío honesto") tienen el mismo fallback SQLSTATE 42883 que ya documentó
// `postgres-core-repository-org-admin-fallback.spec.ts` (PR #149) — mergear a
// `main` despliega el código de inmediato, pero la migración
// `0018_billing_webhook_registro.sql` se aplica DESPUÉS, a mano, así que
// "código nuevo, función SQL todavía inexistente" es el caso NORMAL justo
// después de mergear. Sin este archivo, ese fallback (el que protege el
// webhook de Stripe en producción contra la base sin migrar) no tenía NINGÚN
// test — ver el comentario de cabecera de ambos métodos en
// `../src/postgres-core-repository.ts`.
//
// Hallazgo BLOQUEANTE de revisión (PR #158, ronda 1): este archivo usaba antes
// un `fakeSession` plano (despacha por regex, nunca queda "abortado" — una
// consulta posterior a un error simulado siempre respondía con normalidad, algo
// que Postgres real NUNCA hace) que NO habría detectado que ambos métodos
// corrían el `try/catch` de 42883 SIN `SAVEPOINT` (el mismo defecto que
// `postgres-core-repository-org-admin-fallback.spec.ts` ya cubría para
// `findStaffForOrgAdmin`/`isStaffOrgMember`, pero que `feat(billing): registra
// cada intento de webhook` en `main` reintrodujo para estos dos métodos DESPUÉS
// de la base de esta rama). Ahora usa `AbortAwareFakeSession` (`./support/
// aborting-fake-session.ts`), que sí reproduce 25P02/estado abortado, y agrega
// una prueba de control explícita ("prueba de que el bug era real") que
// reproduce el fallo con la MISMA secuencia de consultas pero sin SAVEPOINT.
//
// Estos tests ejercitan el fallback (ver el comentario de cabecera de ambos
// métodos en `../src/postgres-core-repository.ts`) contra un `TenantDbSession`
// FALSO (nunca Postgres real -- eso ya lo cubre `scripts/verify-billing-
// webhook-registro/` contra Postgres real, que solo puede probar el camino
// NUEVO porque aplica todas las migraciones).
import { describe, expect, it, vi } from "vitest";
import { PostgresCoreRepository } from "../src/postgres-core-repository.ts";
import type { RecordBillingWebhookEventInput } from "../src/core-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function undefinedFunctionError(): Error & { code: string } {
  const err = new Error("function core.record_billing_webhook_event(text, text, uuid, text, text) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

function otherPgError(): Error & { code: string } {
  const err = new Error("terminating connection due to administrator command") as Error & { code: string };
  err.code = "57P01"; // admin_shutdown -- código real de Postgres, deliberadamente NO 42883.
  return err;
}

const EVENT_INPUT: RecordBillingWebhookEventInput = {
  providerEventId: "evt_test123",
  eventType: "customer.subscription.updated",
  organizationId: "00000000-0000-0000-0000-0000000000aa",
  result: "procesado",
  reason: "aplicado",
};

describe("PostgresCoreRepository.recordBillingWebhookEvent -- fallback SQLSTATE 42883", () => {
  it("función existente -> camino NUEVO: llama core.record_billing_webhook_event directo, resuelve sin lanzar", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.record_billing_webhook_event/, respond: () => [] }]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.recordBillingWebhookEvent(EVENT_INPUT)).resolves.toBeUndefined();
  });

  it("función inexistente (42883) -> best-effort no-op: SAVEPOINT recupera la sesión, resuelve sin lanzar, nunca tumba el webhook", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.record_billing_webhook_event/, respond: () => undefinedFunctionError() }]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.recordBillingWebhookEvent(EVENT_INPUT)).resolves.toBeUndefined();
    // El SAVEPOINT sí corrió -- sin esto, la sesión quedaría "abortada" (25P02)
    // para cualquier consulta que el resto del request (ej. el registro real del
    // webhook en `registrarWebhook`) intente correr después en la misma transacción.
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  });

  it("cualquier OTRO código de error (no 42883, p.ej. desconexión transitoria) -- también best-effort: SAVEPOINT recupera la sesión, resuelve sin lanzar, se registra en stderr", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([{ match: /core\.record_billing_webhook_event/, respond: () => otherPgError() }]);
    const repo = new PostgresCoreRepository(session);

    // Por contrato (ver el comentario de cabecera del método): la escritura de
    // bitácora es SIEMPRE best-effort -- ni siquiera un error real de Postgres
    // debe tumbar la respuesta de `POST /billing/webhook`, y la sesión debe quedar
    // utilizable para lo que el request siga haciendo después.
    await expect(repo.recordBillingWebhookEvent(EVENT_INPUT)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    errorSpy.mockRestore();
  });

  it("prueba de que el bug era real: la MISMA secuencia SIN SAVEPOINT (catch simple) deja la sesión abortada para la siguiente consulta del request", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.record_billing_webhook_event/, respond: () => undefinedFunctionError() }]);

    await expect(
      (async () => {
        try {
          await session.query(`select core.record_billing_webhook_event($1, $2, $3, $4, $5);`, []);
        } catch {
          // catch simple -- exactamente el patrón roto que reintrodujo `main`
          // (sin SAVEPOINT, la transacción queda abortada).
        }
        // Cualquier consulta posterior en la MISMA transacción (ej. el propio
        // COMMIT del request) falla con 25P02 en vez de completarse con
        // normalidad -- nunca lo que este método promete (best-effort, nunca
        // tumba el webhook).
        return session.query(`select 1;`, []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});

describe("PostgresCoreRepository.listBillingWebhookLogForSuperadmin -- fallback SQLSTATE 42883", () => {
  const CALLER_ID = "00000000-0000-0000-0000-0000000000cc";
  const FILTERS = { limit: 50, offset: 0 };

  it("función existente -> camino NUEVO: llama core.list_billing_webhook_log_for_superadmin directo", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /core\.list_billing_webhook_log_for_superadmin/,
        respond: () => [
          {
            id: "id-1",
            provider_event_id: "evt_1",
            event_type: "customer.subscription.updated",
            organization_id: "00000000-0000-0000-0000-0000000000aa",
            organization_name: "Org de prueba",
            organization_slug: "org-de-prueba",
            result: "procesado",
            reason: "aplicado",
            created_at: "2026-09-19T00:00:00.000Z",
            total_count: "1",
          },
        ],
      },
    ]);
    const repo = new PostgresCoreRepository(session);

    const result = await repo.listBillingWebhookLogForSuperadmin(CALLER_ID, FILTERS);

    expect(result.disponible).toBe(true);
    expect(result.total).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("función inexistente (42883) -> 'vacío honesto': SAVEPOINT recupera la sesión y devuelve {disponible:false, rows:[], total:0}, NUNCA lanza (la pantalla no debe ver un 500)", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.list_billing_webhook_log_for_superadmin/, respond: () => undefinedFunctionError() }]);
    const repo = new PostgresCoreRepository(session);

    const result = await repo.listBillingWebhookLogForSuperadmin(CALLER_ID, FILTERS);

    expect(result).toEqual({ disponible: false, rows: [], total: 0 });
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  });

  it("cualquier OTRO código de error (no 42883) se repropaga tal cual -- el 'vacío honesto' NUNCA enmascara un fallo real de lectura", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.list_billing_webhook_log_for_superadmin/, respond: () => otherPgError() }]);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.listBillingWebhookLogForSuperadmin(CALLER_ID, FILTERS)).rejects.toMatchObject({ code: "57P01" });
  });

  it("prueba de que el bug era real: la MISMA secuencia SIN SAVEPOINT (catch simple) deriva en 25P02 en vez del 'vacío honesto'", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.list_billing_webhook_log_for_superadmin/, respond: () => undefinedFunctionError() }]);

    await expect(
      (async () => {
        try {
          await session.query(`select ... from core.list_billing_webhook_log_for_superadmin($1, $2, $3, $4, $5, $6, $7, $8);`, []);
        } catch {
          // catch simple -- exactamente el patrón roto que reintrodujo `main`.
        }
        return session.query(`select 1;`, []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
