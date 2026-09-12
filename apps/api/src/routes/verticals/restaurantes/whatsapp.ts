// GET|POST /v1/restaurantes/whatsapp/webhook — port de
// restaurantes/supabase/functions/whatsapp-webhook/index.ts. Sin authMiddleware, sin
// Supabase Auth de usuario: verificación propia por firma HMAC (X-Hub-Signature-256)
// sobre los BYTES CRUDOS del body (ver diseño Fase 1 §4.3b).
//
// CRÍTICO (detalle real que causó bugs reales, según la investigación de patrones):
// esta ruta lee el body con `c.req.raw.arrayBuffer()`, NUNCA `.text()`/`.json()` de
// Hono ni ningún middleware de parseo de JSON montado antes — si algo ya consumió el
// stream del Request, la verificación HMAC falla en falso (o peor, valida un body
// distinto del que Meta realmente firmó). Por eso apps/api/src/app.ts monta este
// sub-Hono ANTES/SIN heredar ningún middleware global de body-parsing, y este archivo
// nunca importa ni usa `c.req.json()`.
import { Hono } from "hono";
import { extractMetaPhoneNumberId, extractMetaTextMessages, handleInboundWhatsAppMessage, verifyMetaSignature } from "@atiende/domain-restaurantes";
import { constantTimeEqual } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const MAX_BODY_BYTES = 256 * 1024;

export function restaurantesWhatsAppRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // Handshake de verificación real de Meta: GET con
  // hub.mode/hub.verify_token/hub.challenge.
  app.get("/v1/restaurantes/whatsapp/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && constantTimeEqual(token ?? null, deps.env.whatsappVerifyToken)) {
      return c.text(challenge ?? "");
    }
    return c.text("Forbidden", 403);
  });

  app.post("/v1/restaurantes/whatsapp/webhook", async (c) => {
    const declaredLength = Number(c.req.header("content-length") ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES) {
      return c.text("Payload too large", 413);
    }
    const rawBody = new Uint8Array(await c.req.raw.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) return c.text("Payload too large", 413);

    if (!deps.env.whatsappAppSecret) return c.text("Webhook not configured", 503);
    if (!(await verifyMetaSignature(rawBody, c.req.header("x-hub-signature-256") ?? null, deps.env.whatsappAppSecret))) {
      return c.text("Invalid signature", 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return c.text("Invalid JSON", 400);
    }

    // Webhook público/de sistema, sin authMiddleware/dbSession -- abre su propia
    // sesión de sistema (`userId: null`), igual que public.ts/voice-tools.ts.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      const phoneNumberId = extractMetaPhoneNumberId(payload);
      const organizationId = phoneNumberId ? await repo.resolveOrganizationByPhoneNumberId(phoneNumberId) : null;
      if (!organizationId) {
        // Número no configurado en la plataforma: ack silencioso, no reintento.
        return c.json({ ok: true });
      }

      const incomingMessages = extractMetaTextMessages(payload);
      if (incomingMessages.length === 0) {
        return c.json({ ok: true });
      }

      let hadRetryableFailure = false;
      for (const message of incomingMessages) {
        const outcome = await handleInboundWhatsAppMessage(repo, deps.turnHandler, {
          organizationId,
          messageId: message.id,
          phone: `+${message.from}`,
          body: message.text.body,
        });
        // El envío real de `outcome.reply` vía Graph API es responsabilidad del
        // dispatcher de apps/worker (messaging_outbox), fuera de las 3 rutas críticas
        // de esta fase (ver diseño §1, fila messaging_outbox) — aquí solo se procesa y
        // persiste la conversación/pedido, exactamente la plomería que sí es de esta
        // fase.
        if (outcome.retryable) hadRetryableFailure = true;
      }

      // Meta reintenta el batch firmado completo ante cualquier respuesta no-2xx. Los
      // mensajes ya procesados quedan idempotentemente saltados por el ledger de
      // entrada; los fallidos/ocupados se pueden reclamar en el reintento.
      return c.json({ ok: !hadRetryableFailure }, hadRetryableFailure ? 500 : 200);
    });
  });

  return app;
}
