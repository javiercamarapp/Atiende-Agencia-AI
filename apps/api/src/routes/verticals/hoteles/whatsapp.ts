// GET|POST /v1/hoteles/whatsapp/webhook — Fase 2 hoteles §2.2, copia estructural de
// apps/api/src/routes/verticals/restaurantes/whatsapp.ts. Sin authMiddleware, sin
// Supabase Auth de usuario: verificación propia por firma HMAC (X-Hub-Signature-256)
// sobre los BYTES CRUDOS del body.
//
// Secreto de WhatsApp SÍ es compartido de plataforma (WHATSAPP_APP_SECRET/
// WHATSAPP_VERIFY_TOKEN) — a diferencia de voz, aquí no hay divergencia respecto a
// restaurantes: el diseño confirma que el origen real de hoteles también usa una
// sola Meta App compartida (ver diseño §0/§1). Lo que SÍ es nuevo: el número
// resuelve directo a una PROPERTY (no a una organización) — cada property de
// hoteles tiene su propio `phone_number_id`, así que no hace falta resolver
// sucursal como en restaurantes.
//
// CRÍTICO (mismo detalle real que restaurantes): esta ruta lee el body con
// `c.req.raw.arrayBuffer()`, NUNCA `.text()`/`.json()` de Hono — por eso app.ts monta
// este sub-Hono sin heredar ningún middleware global de body-parsing.
import { Hono } from "hono";
import { extractMetaPhoneNumberId, extractMetaTextMessages, handleInboundWhatsAppMessage, resolvePropertyByPhoneNumberId, verifyMetaSignature } from "@atiende/domain-hoteles";
import { constantTimeEqual } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const MAX_BODY_BYTES = 256 * 1024;

export function hotelesWhatsAppRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/v1/hoteles/whatsapp/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && constantTimeEqual(token ?? null, deps.env.whatsappVerifyToken)) {
      return c.text(challenge ?? "");
    }
    return c.text("Forbidden", 403);
  });

  app.post("/v1/hoteles/whatsapp/webhook", async (c) => {
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

    const phoneNumberId = extractMetaPhoneNumberId(payload);
    const route = phoneNumberId ? await resolvePropertyByPhoneNumberId(deps.hotelesRepo, phoneNumberId) : null;
    if (!route) {
      // Número no configurado en la plataforma: ack silencioso, no reintento.
      return c.json({ ok: true });
    }

    const incomingMessages = extractMetaTextMessages(payload);
    if (incomingMessages.length === 0) {
      return c.json({ ok: true });
    }

    let hadRetryableFailure = false;
    for (const message of incomingMessages) {
      const outcome = await handleInboundWhatsAppMessage(deps.hotelesRepo, deps.hotelesTurnHandler, {
        organizationId: route.organizationId,
        propertyId: route.propertyId,
        messageId: message.id,
        phone: `+${message.from}`,
        body: message.text.body,
      });
      // El envío real de `outcome.reply` vía Graph API es responsabilidad del
      // dispatcher de apps/worker (messaging_outbox) — fuera de esta fase, igual
      // criterio que restaurantes.
      if (outcome.retryable) hadRetryableFailure = true;
    }

    return c.json({ ok: !hadRetryableFailure }, hadRetryableFailure ? 500 : 200);
  });

  return app;
}
