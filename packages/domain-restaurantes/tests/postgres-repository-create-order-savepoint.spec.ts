// No-bloqueante de la re-revisión del PR #158 (r3) -- `createOrderIdempotent` es el
// sitio hermano en `domain-restaurantes` de los métodos de ciclo de vida de citas
// convertidos en esta misma ronda (`postgres-repository-lifecycle-rpc-savepoint
// .spec.ts` de `domain-citas`): un catch de PT409 sin `runWithRowSavepoint`
// alrededor del RPC deja la sesión ABORTADA aunque el catch mapee el error a
// `OrderConflictError`. Hoy los dos callers reales (`apps/api/.../restaurantes/
// public.ts`, que siempre RELANZA fuera de `withAppSession`, y el agente de
// WhatsApp, ya protegido por el `runWithRowSavepoint` exterior de `executeToolCall`)
// no exponen esto como una regresión observable -- se convierte por simetría/defensa
// en profundidad, para que un caller futuro que mapee `OrderConflictError` a una
// respuesta normal (como ya hace `appointments-lifecycle.ts::mapErrorToHttp` con
// `AppointmentAlternativesError`) no herede el mismo riesgo.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { OrderConflictError } from "../src/errors.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "00000000-0000-0000-0000-0000000000o1";
const PROPERTY_ID = "00000000-0000-0000-0000-0000000000p1";

function pt409(): Error & { code: string } {
  const err = new Error("idempotency_key reused with a different dedupe_fingerprint") as Error & { code: string };
  err.code = "PT409";
  return err;
}

describe("PostgresRestaurantesRepository.createOrderIdempotent — SAVEPOINT alrededor del RPC (r3, defensa en profundidad)", () => {
  it("PT409 -> OrderConflictError tipado, sesión utilizable DESPUÉS (nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /restaurantes\.create_order_idempotent/, respond: () => pt409() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    const caught = await repo
      .createOrderIdempotent(
        {
          organizationId: ORG_ID,
          propertyId: PROPERTY_ID,
          customerId: null,
          customerName: "Ana",
          customerPhone: "+525500000000",
          customerAddress: null,
          customerEmail: null,
          branch: "Centro",
          total: 150,
          items: [],
          source: "web",
          notes: null,
          paymentMethod: null,
          callTranscript: null,
          callRecordingUrl: null,
        },
        "fp1",
        "idem-1",
      )
      .catch((e: unknown) => e);

    expect(caught).toBeInstanceOf(OrderConflictError);
    // Mismo criterio que el resto de esta ronda: SAVEPOINT abierto, recuperado, y
    // una consulta normal posterior sobre la MISMA sesión no lanza 25P02.
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });
});
