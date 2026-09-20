// Hallazgo de revisores (19-sep-2026, misma causa raíz que el bloqueante de
// `whatsapp-llm-turn-handler-savepoint.spec.ts`, PR #158 r3, pero en la capa de
// arriba): `handleInboundWhatsAppMessage` (../src/whatsapp/inbound.ts) corre TODO
// su cuerpo (append del mensaje del usuario, turno, `whatsappAppendTurn`,
// `enqueueMessagingOutbox`, `finishWhatsAppMessage`) en la ÚNICA transacción del
// webhook (`ManagedPostgresEngine.withAppSession`). Antes de este fix, si
// CUALQUIERA de esos pasos lanzaba un error real de Postgres, el `catch` de abajo
// reutilizaba esa MISMA sesión ya abortada (25P02) para
// `finishWhatsAppMessage(..., "failed", ...)` -- esa llamada fallaba también,
// escapaba sin marcar nada, y el `COMMIT` de `withAppSession` lanzaba
// `AbortedTransactionCommitError` -> 500 a Meta -> reintentos sin tope que
// re-corren el turno LLM completo (gasto real) sin que el huésped reciba jamás
// una respuesta.
//
// Mismo diseño de test que `whatsapp-llm-turn-handler-savepoint.spec.ts`:
// `AbortAwareFakeSession` (reproduce la semántica REAL de una transacción de
// Postgres) + `PostgresHotelesRepository` real (nunca `InMemoryHotelesRepository`,
// que no tiene transacción real que abortar) + un `HotelesWhatsAppTurnHandler` de
// prueba (sin LLM, para aislar el defecto de esta capa del ya cubierto en
// llm-turn-handler.ts).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { PostgresHotelesRepository } from "../src/postgres-repository.ts";
import type { HotelesWhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function genericPostgresError(): Error & { code: string } {
  // No hace falta que sea un SQLSTATE reconocido -- el punto es que el `catch` de
  // `handleInboundWhatsAppMessage` debe recuperarse de CUALQUIER error real de
  // Postgres, no solo de los códigos ya mapeados a una excepción de negocio.
  const err = new Error('relation "hoteles.messaging_outbox" does not exist') as Error & { code: string };
  err.code = "42P01";
  return err;
}

const fixedReplyTurnHandler: HotelesWhatsAppTurnHandler = {
  async handleInboundMessage() {
    return { reply: "Gracias, tu solicitud quedó registrada.", fnbOrderId: null };
  },
};

describe("handleInboundWhatsAppMessage (hoteles) — SAVEPOINT alrededor del turno completo, contra Postgres real (AbortAwareFakeSession)", () => {
  it("enqueueMessagingOutbox dispara un error real de Postgres DESPUÉS de que el turno ya corrió: el fallo queda REGISTRADO (finish_whatsapp_message 'failed' corre y no lanza), el handler responde retryable sin lanzar, y la sesión queda utilizable para el resto del request", async () => {
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    const messageId = randomUUID();

    const session = new AbortAwareFakeSession([
      { match: /select hoteles\.claim_whatsapp_message/, respond: () => [{ claim_whatsapp_message: true }] },
      { match: /select hoteles\.claim_whatsapp_conversation/, respond: () => [{ claim_whatsapp_conversation: true }] },
      { match: /select organization_id from core\.property/, respond: () => [{ organization_id: organizationId }] },
      { match: /select hoteles\.append_whatsapp_user_message_once/, respond: () => [] },
      { match: /select hoteles\.whatsapp_append_turn/, respond: () => [] },
      // El paso que revienta -- DESPUÉS de que el turno completo ya produjo una
      // respuesta y se guardó en el historial.
      { match: /select hoteles\.enqueue_messaging_outbox/, respond: () => genericPostgresError() },
      { match: /select hoteles\.finish_whatsapp_message/, respond: () => [] },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresHotelesRepository(session);

    const outcome = await handleInboundWhatsAppMessage(repo, fixedReplyTurnHandler, {
      organizationId,
      propertyId,
      messageId,
      phone: "+5219990000000",
      body: "hola, necesito ayuda",
      phoneNumberId: "1234567890",
    });

    // EFECTO 1: el handler nunca lanza -- responde reintentable, sin `reply` (Meta
    // reintentará el batch firmado completo).
    expect(outcome).toEqual({ ok: false, retryable: true });

    // EFECTO 2: el fallo quedó REGISTRADO de verdad -- `finish_whatsapp_message`
    // corrió con status 'failed' y la clase del error real, sobre la sesión ya
    // recuperada (si el SAVEPOINT no hubiera protegido el bloque, esta consulta
    // habría lanzado 25P02 y nunca habría llegado a ejecutarse).
    const finishCall = session.calls.find((c) => c.startsWith("select hoteles.finish_whatsapp_message"));
    expect(finishCall).toBeDefined();

    // El aislamiento fue con SAVEPOINT/ROLLBACK TO SAVEPOINT -- no un catch simple.
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);

    // El propio `finish_whatsapp_message` corrió DESPUÉS del `rollback to savepoint`
    // (nunca antes -- si corriera antes habría lanzado 25P02 y el test de arriba ya
    // habría fallado, pero se afirma el orden explícitamente para que el test no
    // pase "por accidente").
    const rollbackIdx = session.calls.findIndex((c) => c.startsWith("rollback to savepoint sp_fallback_"));
    const finishIdx = session.calls.findIndex((c) => c.startsWith("select hoteles.finish_whatsapp_message"));
    expect(rollbackIdx).toBeGreaterThanOrEqual(0);
    expect(finishIdx).toBeGreaterThan(rollbackIdx);

    // EFECTO 3: la sesión sigue utilizable DESPUÉS de todo el request -- exactamente
    // la precondición que hace que el COMMIT real de `withAppSession` regrese el tag
    // 'COMMIT' (nunca 'ROLLBACK'), es decir, que `managed-postgres-engine.ts` NUNCA
    // lance `AbortedTransactionCommitError` para este request.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("control: la MISMA secuencia con un catch simple (sin SAVEPOINT) deja la sesión abortada -- prueba de que el bug era real", async () => {
    const session = new AbortAwareFakeSession([{ match: /select hoteles\.enqueue_messaging_outbox/, respond: () => genericPostgresError() }]);

    await expect(
      (async () => {
        try {
          await session.query("select hoteles.enqueue_messaging_outbox($1, $2, $3, $4, $5, $6::jsonb);", []);
        } catch {
          // catch simple -- exactamente el patrón roto que `handleInboundWhatsAppMessage`
          // tenía antes de envolver el cuerpo del turno en `repo.runWithRowSavepoint`.
        }
        // El catch roto intentaría registrar el fallo aquí, sobre la sesión ya abortada.
        return session.query("select hoteles.finish_whatsapp_message($1, $2, $3, $4, $5);", []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});
