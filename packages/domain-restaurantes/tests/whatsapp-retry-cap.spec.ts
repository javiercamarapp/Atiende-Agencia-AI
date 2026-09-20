// Fase 2 (integridad) — "los reintentos de WhatsApp entrante no tienen tope, y
// cada reintento de Meta vuelve a gastar un turno de LLM". El tope real
// (`v_max_attempts` dentro de `restaurantes.claim_whatsapp_message`) vive en
// `migrations/020_whatsapp_retry_cap.sql` -- ver
// `scripts/verify-restaurantes-whatsapp-retry-cap/assertions.sql` para la prueba
// reproducible del tope contra Postgres real (SQL real, RLS real). Este archivo
// verifica el EFECTO complementario del lado de TypeScript, que Postgres real no
// puede demostrar por sí solo: una vez que `claim_whatsapp_message` deja de
// reclamar (mensaje en `'attempts_exhausted'`), `handleInboundWhatsAppMessage`
// (../src/whatsapp/inbound.ts) corta ANTES de invocar `turnHandler.
// handleInboundMessage` -- el N-ésimo reintento de Meta YA NO vuelve a correr el
// turno del LLM (gasto real evitado), ni vuelve a intentar el lease/turno/outbox.
//
// Mismo doble de prueba que `whatsapp-inbound-savepoint.spec.ts`:
// `AbortAwareFakeSession` (reproduce la semántica REAL de una transacción de
// Postgres) + `PostgresRestaurantesRepository` real (nunca
// `InMemoryRestaurantesRepository`, que no reproduce el SQL real de
// `claim_whatsapp_message`) -- aquí el mock del `claim_whatsapp_message` de la
// sesión SIMULA el tope real (true en los intentos 1..MAX, false a partir de
// MAX+1), exactamente el contrato que la migración 020 le da a Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleInboundWhatsAppMessage } from "../src/whatsapp/inbound.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

// Mismo valor que `v_max_attempts` en
// packages/domain-restaurantes/migrations/020_whatsapp_retry_cap.sql.
const MAX_WHATSAPP_ATTEMPTS = 5;

describe("handleInboundWhatsAppMessage (restaurantes) — tope de reintentos: el N-ésimo intento NO vuelve a invocar al LLM", () => {
  it(`reclama los intentos 1..${MAX_WHATSAPP_ATTEMPTS} (turnHandler corre cada vez, y falla cada vez -- mensaje persistentemente problemático) y el intento ${MAX_WHATSAPP_ATTEMPTS + 1} ya NO reclama: turnHandler NUNCA se invoca esa vez, sin lanzar`, async () => {
    const organizationId = randomUUID();
    const messageId = randomUUID();

    let claimCallCount = 0;
    const session = new AbortAwareFakeSession([
      {
        match: /select restaurantes\.claim_whatsapp_message/,
        respond: () => {
          claimCallCount += 1;
          // Mismo contrato que la función SQL real tras 020_whatsapp_retry_cap.sql:
          // reclama mientras `attempts <= MAX`, deja de reclamar (y el mensaje queda
          // 'attempts_exhausted') a partir de ahí -- ver
          // scripts/verify-restaurantes-whatsapp-retry-cap/assertions.sql para la
          // prueba de ESE contrato contra Postgres real.
          return [{ claim_whatsapp_message: claimCallCount <= MAX_WHATSAPP_ATTEMPTS }];
        },
      },
      { match: /select restaurantes\.claim_whatsapp_conversation/, respond: () => [{ claim_whatsapp_conversation: true }] },
      { match: /select restaurantes\.append_whatsapp_user_message_once/, respond: () => [] },
      // Cliente nunca visto -- `lookupCustomer` corta ahí, sin más consultas.
      { match: /select id, organization_id, phone, name, order_count from restaurantes\.customers/, respond: () => [] },
      { match: /select restaurantes\.whatsapp_append_turn/, respond: () => [] },
      { match: /select restaurantes\.finish_whatsapp_message/, respond: () => [] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    let turnHandlerCallCount = 0;
    const alwaysFailingTurnHandler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        turnHandlerCallCount += 1;
        // El cliente tiene una causa PERSISTENTE (p. ej. el catch genérico del PR
        // #178 registrando 'failed' cada vez) -- cada reintento de Meta vuelve a
        // fallar, mismo `messageId`, hasta agotar el tope.
        throw new Error("LLM upstream failure (simulada, persistente)");
      },
    };

    const args = { organizationId, messageId, phone: "+5219990000000", body: "hola, necesito ayuda", phoneNumberId: "1234567890" };

    const outcomes = [];
    for (let attempt = 1; attempt <= MAX_WHATSAPP_ATTEMPTS + 1; attempt += 1) {
      outcomes.push(await handleInboundWhatsAppMessage(repo, alwaysFailingTurnHandler, args));
    }

    // EFECTO 1: turnHandler corrió EXACTAMENTE los primeros MAX_WHATSAPP_ATTEMPTS
    // intentos -- nunca menos (no se bloqueó de más pronto) y nunca más (el
    // (MAX+1)-ésimo no lo tocó).
    expect(turnHandlerCallCount).toBe(MAX_WHATSAPP_ATTEMPTS);

    // EFECTO 2: los primeros MAX_WHATSAPP_ATTEMPTS intentos, aunque el turno falló,
    // el handler nunca lanza -- responde reintentable (Meta reintentará).
    for (let i = 0; i < MAX_WHATSAPP_ATTEMPTS; i += 1) {
      expect(outcomes[i]).toEqual({ ok: false, retryable: true });
    }

    // EFECTO 3 (el que demuestra el fix): el intento MAX_WHATSAPP_ATTEMPTS+1 --
    // aquel al que `claim_whatsapp_message` ya no reclama -- el handler responde
    // `{ ok: true, retryable: false }` (ack sin reintento, 200 a Meta en la ruta
    // HTTP -- ver apps/api/src/routes/verticals/restaurantes/whatsapp.ts) SIN
    // lanzar y SIN volver a invocar turnHandler -- Meta deja de reintentar, y ya no
    // se gasta ningún turno más del LLM.
    expect(outcomes[MAX_WHATSAPP_ATTEMPTS]).toEqual({ ok: true, retryable: false });

    // EFECTO 4: ese último intento tampoco llegó a pedir el lease de conversación
    // ni a tocar el resto de la plomería del turno -- `claimed = false` corta
    // inmediatamente, antes de `claimWhatsAppConversation`.
    const claimConversationCalls = session.calls.filter((c) => c.startsWith("select restaurantes.claim_whatsapp_conversation")).length;
    expect(claimConversationCalls).toBe(MAX_WHATSAPP_ATTEMPTS);

    // EFECTO 5: `claim_whatsapp_message` sí se invocó una vez por cada intento real
    // -- MAX_WHATSAPP_ATTEMPTS + 1 en total (incluido el que ya no reclamó).
    expect(claimCallCount).toBe(MAX_WHATSAPP_ATTEMPTS + 1);
  });

  it("un mensaje que YA no se reclama (claimed = false) nunca invoca al turnHandler, sin importar la causa (mismo camino que un mensaje ya 'processed' o ya 'attempts_exhausted')", async () => {
    const organizationId = randomUUID();
    const messageId = randomUUID();

    const session = new AbortAwareFakeSession([{ match: /select restaurantes\.claim_whatsapp_message/, respond: () => [{ claim_whatsapp_message: false }] }]);
    const repo = new PostgresRestaurantesRepository(session);

    let turnHandlerCallCount = 0;
    const turnHandler: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        turnHandlerCallCount += 1;
        return { reply: "no debería llegar aquí", orderId: null, propertyId: null };
      },
    };

    const outcome = await handleInboundWhatsAppMessage(repo, turnHandler, {
      organizationId,
      messageId,
      phone: "+5219990000000",
      body: "hola",
      phoneNumberId: "1234567890",
    });

    expect(outcome).toEqual({ ok: true, retryable: false });
    expect(turnHandlerCallCount).toBe(0);
    // Ninguna otra consulta corrió -- `handleInboundWhatsAppMessage` corta en la
    // primera línea, antes de tocar el lease/turno/outbox.
    expect(session.calls).toEqual(["select restaurantes.claim_whatsapp_message($1, $2, $3) as claim_whatsapp_message;"]);
  });
});
