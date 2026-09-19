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
// Mismo patrón que el archivo de PR #149: `TenantDbSession` FALSO (nunca
// Postgres real — eso ya lo cubre `scripts/verify-billing-webhook-registro/`
// contra Postgres real, que solo puede probar el camino NUEVO porque aplica
// todas las migraciones).
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresCoreRepository } from "../src/postgres-core-repository.ts";
import type { RecordBillingWebhookEventInput } from "../src/core-repository.ts";

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

function fakeSession(handler: () => unknown): TenantDbSession {
  return {
    async query<T>(): Promise<{ rows: T[] }> {
      const result = handler();
      if (result instanceof Error) throw result;
      return { rows: result as T[] };
    },
    async exec(): Promise<void> {
      throw new Error("fakeSession.exec no debería usarse en estos tests");
    },
  };
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
    const session = fakeSession(() => []);
    const repo = new PostgresCoreRepository(session);

    await expect(repo.recordBillingWebhookEvent(EVENT_INPUT)).resolves.toBeUndefined();
  });

  it("función inexistente (42883) -> best-effort no-op: resuelve sin lanzar, nunca tumba el webhook", async () => {
    const session = fakeSession(() => undefinedFunctionError());
    const repo = new PostgresCoreRepository(session);

    await expect(repo.recordBillingWebhookEvent(EVENT_INPUT)).resolves.toBeUndefined();
  });

  it("cualquier OTRO código de error (no 42883, p.ej. desconexión transitoria) -- también best-effort: resuelve sin lanzar, se registra en stderr", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = fakeSession(() => otherPgError());
    const repo = new PostgresCoreRepository(session);

    // Por contrato (ver el comentario de cabecera del método): la escritura de
    // bitácora es SIEMPRE best-effort -- ni siquiera un error real de Postgres
    // debe tumbar la respuesta de `POST /billing/webhook`.
    await expect(repo.recordBillingWebhookEvent(EVENT_INPUT)).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe("PostgresCoreRepository.listBillingWebhookLogForSuperadmin -- fallback SQLSTATE 42883", () => {
  const CALLER_ID = "00000000-0000-0000-0000-0000000000cc";
  const FILTERS = { limit: 50, offset: 0 };

  it("función existente -> camino NUEVO: llama core.list_billing_webhook_log_for_superadmin directo", async () => {
    const session = fakeSession(() => [
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
    ]);
    const repo = new PostgresCoreRepository(session);

    const result = await repo.listBillingWebhookLogForSuperadmin(CALLER_ID, FILTERS);

    expect(result.disponible).toBe(true);
    expect(result.total).toBe(1);
    expect(result.rows).toHaveLength(1);
  });

  it("función inexistente (42883) -> 'vacío honesto': {disponible:false, rows:[], total:0}, NUNCA lanza (la pantalla no debe ver un 500)", async () => {
    const session = fakeSession(() => undefinedFunctionError());
    const repo = new PostgresCoreRepository(session);

    const result = await repo.listBillingWebhookLogForSuperadmin(CALLER_ID, FILTERS);

    expect(result).toEqual({ disponible: false, rows: [], total: 0 });
  });

  it("cualquier OTRO código de error (no 42883) se repropaga tal cual -- el 'vacío honesto' NUNCA enmascara un fallo real de lectura", async () => {
    const session = fakeSession(() => otherPgError());
    const repo = new PostgresCoreRepository(session);

    await expect(repo.listBillingWebhookLogForSuperadmin(CALLER_ID, FILTERS)).rejects.toMatchObject({ code: "57P01" });
  });
});
