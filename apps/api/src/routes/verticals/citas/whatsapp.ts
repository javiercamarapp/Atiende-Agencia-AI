// GET|POST /v1/citas/whatsapp/webhook — port de
// apps/api/src/routes/verticals/restaurantes/whatsapp.ts al vertical de citas
// (Fase 1 de citas NO construyó esta plomería, ver diseño Fase 2 §0/§2.6). Sin
// authMiddleware, sin Supabase Auth de usuario: verificación propia por firma HMAC
// (X-Hub-Signature-256) sobre los BYTES CRUDOS del body.
//
// CRÍTICO (mismo detalle real que restaurantes): esta ruta lee el body con
// `c.req.raw.arrayBuffer()`, NUNCA `.text()`/`.json()` de Hono ni ningún
// middleware de parseo de JSON montado antes — si algo ya consumió el stream del
// Request, la verificación HMAC falla en falso (o peor, valida un body distinto
// del que Meta realmente firmó). Por eso este archivo nunca importa ni usa
// `c.req.json()`.
import { Hono } from "hono";
import { extractMetaPhoneNumberId, extractMetaTextMessages, handleInboundWhatsAppMessage, verifyMetaSignature } from "@atiende/domain-citas";
import { rateLimit } from "@atiende/core-ratelimit";
import { constantTimeEqual, requestActor } from "../../../http-security.ts";
import { triggerCitasWhatsAppDispatchInline } from "../../internal/whatsapp-dispatch.ts";
import { triggerCitasEmailDispatchInline } from "./email-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";

const MAX_BODY_BYTES = 256 * 1024;

// Hallazgo de auditoría (ALTO, "packages/core-ratelimit cataloga la categoría
// 'conversation:inbound-webhook' -- ABIERTA (degrada a memoria, nunca a cero) ver
// endpoint-policy.ts -- pero ningún webhook real la invocaba"). La firma HMAC ya
// garantiza que el remitente es Meta real -- este límite es la segunda línea que la
// propia fila de la tabla documenta: acotar la ráfaga de procesamiento (turn handler
// -> LLM -> outbox) por número de WhatsApp de esta organización, nunca dejarla sin
// tope. Ante negativa, 429 (no 200 silencioso ni 5xx) -- Meta reintenta con 429 igual
// que con 5xx.
const INBOUND_WEBHOOK_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;

export function citasWhatsAppRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // Handshake de verificación real de Meta: GET con
  // hub.mode/hub.verify_token/hub.challenge. Mismo verify_token de plataforma que
  // restaurantes (una sola Meta App compartida, ver diseño Fase 1 restaurantes
  // §4.3a) — el `phone_number_id` de cada mensaje es lo único que rutea a la
  // organización correcta.
  app.get("/v1/citas/whatsapp/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && constantTimeEqual(token ?? null, deps.env.whatsappVerifyToken)) {
      return c.text(challenge ?? "");
    }
    return c.text("Forbidden", 403);
  });

  app.post("/v1/citas/whatsapp/webhook", async (c) => {
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

    // Hallazgo de auditoría (ALTO) — ver comentario de cabecera del archivo.
    // Evaluado DESPUÉS de verificar la firma (para no gastar cupo en tráfico que ni
    // siquiera prueba ser de Meta) pero ANTES de abrir sesión de base de datos.
    const inboundAllowed = await rateLimit(
      `conversation:inbound-webhook:${requestActor(c.req.raw, phoneNumberId ?? "sin-numero")}`,
      INBOUND_WEBHOOK_RATE_LIMIT.max,
      INBOUND_WEBHOOK_RATE_LIMIT.windowMs,
      { category: "conversation:inbound-webhook" },
    );
    if (!inboundAllowed) return c.text("Too Many Requests", 429);

    // Webhook público/de sistema, sin authMiddleware/dbSession -- abre su propia
    // sesión de sistema (`userId: null`), igual que el resto de rutas
    // públicas/de sistema de este vertical.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      // f2-citas-whatsapp-config-sesion-sistema — esta sesión es SIEMPRE de
      // SISTEMA (`userId: null`, Meta no manda ningún usuario autenticado):
      // `resolveOrganizationByPhoneNumberId` (variante de STAFF, RLS de
      // membership sobre `citas.whatsapp_config`) SIEMPRE devolvía 0 filas
      // aquí -- ningún mensaje entrante de WhatsApp de citas resolvía jamás
      // una organización contra Postgres real. Ver el comentario largo de
      // `repository.ts::resolveOrganizationByPhoneNumberIdAsSystem`.
      const organizationId = phoneNumberId ? await citasRepo.resolveOrganizationByPhoneNumberIdAsSystem(phoneNumberId) : null;
      if (!phoneNumberId || !organizationId) {
        // Número no configurado en la plataforma: ack silencioso, no reintento.
        return c.json({ ok: true });
      }

      const incomingMessages = extractMetaTextMessages(payload);
      if (incomingMessages.length === 0) {
        return c.json({ ok: true });
      }

      let hadRetryableFailure = false;
      for (const message of incomingMessages) {
        const outcome = await handleInboundWhatsAppMessage(citasRepo, deps.citasTurnHandler, deps.citasConversationGuard, {
          organizationId,
          messageId: message.id,
          phone: `+${message.from}`,
          body: message.text.body,
          phoneNumberId,
        });
        // El envío real de `outcome.reply` vía Graph API ya no vive fuera de fase:
        // `handleInboundWhatsAppMessage` lo encola en `citas.messaging_outbox`
        // (ver whatsapp/inbound.ts) y `POST /internal/whatsapp/dispatch`
        // (@atiende/whatsapp-gateway::WhatsAppOutboundDispatcher) lo drena de
        // verdad vía Graph API — mismo patrón de scheduler externo que
        // `/internal/citas/confirmacion-cita`.
        if (outcome.retryable) hadRetryableFailure = true;
      }

      // Cluster #3 (CRÍTICO) de la auditoría final: intento de envío INLINE
      // best-effort de la(s) respuesta(s) recién encoladas arriba, en vez de
      // esperar hasta el cron diario de `/internal/whatsapp/dispatch` (hasta 24h
      // de latencia real para un producto que se vende como agente
      // conversacional). Usa el MISMO `citasRepo`/transacción de este request
      // (nunca abre una sesión nueva) para poder ver la fila que `outcome.reply`
      // acaba de encolar aunque esta transacción todavía no haya hecho commit —
      // ver comentario de cabecera de whatsapp-dispatch.ts. Nunca puede convertir
      // esta respuesta en un error: el cron diario sigue como red de seguridad.
      await triggerCitasWhatsAppDispatchInline(deps, db, citasRepo);
      // El agente también puede haber agendado/cancelado/reagendado una cita
      // DENTRO de esta misma conversación (llm-turn-handler.ts), lo que encola un
      // correo real vía tryEnqueueAppointmentEmail — mismo disparo inline.
      await triggerCitasEmailDispatchInline(deps, db, citasRepo);

      // Meta reintenta el batch firmado completo ante cualquier respuesta no-2xx. Los
      // mensajes ya procesados quedan idempotentemente saltados por el ledger de
      // entrada; los fallidos/ocupados se pueden reclamar en el reintento.
      return c.json({ ok: !hadRetryableFailure }, hadRetryableFailure ? 500 : 200);
    });
  });

  return app;
}
