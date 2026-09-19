// POST /hoteles/cfdi/webhook — segunda mitad del hallazgo P1 de la auditoría de 22
// rubros ("wirear el webhook del PAC de CFDI: está implementado y probado en el
// puerto, solo falta la ruta HTTP"). `@atiende/mcp-cfdi::CfdiPort.verifyAndNormalizeWebhook`
// (dual-PAC, Finkok/SW Sapien) YA verifica la firma HMAC del evento y lo normaliza
// a `CfdiWebhookEvent` — lo que faltaba era ESTA ruta.
//
// El hueco real que cierra: si el PAC notifica de forma asíncrona que un CFDI
// cambió de estado (p. ej. una cancelación que requería aceptación/rechazo del
// receptor — ciclo 2022+ del SAT, ver comentario de cabecera de port.ts — resuelta
// días después), antes de esta ruta NADIE lo recibía: el estado local quedaba
// desactualizado hasta que un staff pulsara manualmente "consultar estado"
// (POST /hoteles/:propertyId/cfdi/:cfdiId/consultar-estado, ver cfdi.ts).
//
// Mismo patrón que los otros dos webhooks entrantes de este monorepo:
//   - `billing.ts` (POST /billing/webhook, Stripe): sin credenciales -> 503
//     honesto; firma sobre BYTES/TEXTO crudo verificada ANTES de cualquier
//     efecto; firma inválida -> 401.
//   - `hoteles/whatsapp.ts` (POST /v1/hoteles/whatsapp/webhook, Meta): sin
//     `authMiddleware` (quien llama es un tercero, no un staff con JWT); abre su
//     propia sesión de sistema (`engine.withAppSession({ userId: null }, ...)`)
//     porque no hay `organizationId` en la request; rate-limit evaluado DESPUÉS
//     de verificar la firma, para no gastar cupo en tráfico que ni siquiera
//     prueba venir del proveedor real.
//
// Localización cross-tenant del CFDI: el PAC manda el UUID fiscal, nunca un
// `propertyId` — `repo.applyCfdiWebhookStatus(uuid, status)` (ver
// `@atiende/domain-hoteles::HotelesRepository`) localiza + aplica la transición
// vía la función `security definer` `hoteles.apply_cfdi_webhook_status`
// (packages/domain-hoteles/migrations/020_cfdi_webhook_status_security_definer.sql):
// la política RLS real de `hoteles.cfdi_emision` exige `auth.uid()` con membership
// de dinero de la property, que una sesión de sistema nunca satisface para
// NINGUNA property — un UPDATE normal aquí no tocaría ninguna fila, en silencio.
import { Hono } from "hono";
import { rateLimit } from "@atiende/core-ratelimit";
import { PortUnavailableError, WebhookReplayError, WebhookSignatureError } from "@atiende/mcp-cfdi";
import type { DomainCfdiStatus } from "@atiende/mcp-cfdi";
import { Errors } from "../../../errors.ts";
import { readTextCapped, requestActor } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

// PAC puede mandar payloads con varios eventos acumulados/metadata extra —
// mismo criterio que `billingRoutes`/`restaurantesWhatsAppRoutes` para el resto de
// webhooks de proveedores externos: límite generoso pero explícito, nunca sin
// límite.
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

// Hallazgo de auditoría (webhook entrante de un servicio externo, sin sesión de
// usuario) — reutiliza la categoría 'conversation:inbound-webhook' que
// packages/core-ratelimit YA cataloga para "un webhook entrante (WhatsApp u otro
// canal)" (ver endpoint-policy.ts) y que el PR #117 conectó al webhook de
// WhatsApp (hoteles/whatsapp.ts) — 'open' (degradado al backend en memoria de
// esta instancia, NUNCA a cero) y, ante negativa, 429 explícito (nunca 200
// silencioso ni 5xx) para que el PAC reintente más tarde. Deliberadamente NO es
// 'mcp:cfdi' (cerrada): esa categoría está catalogada para las llamadas
// SALIENTES al PAC (costo monetario directo por llamada + riesgo de timbrado
// duplicado, ver cfdi.ts) — recibir una notificación no cuesta dinero ni duplica
// ningún timbrado por sí sola, es el mismo tipo de riesgo (ráfaga/abuso de
// procesamiento) que el resto de webhooks entrantes ya catalogados aquí.
//
// Límite por IP únicamente — a diferencia de WhatsApp (que trae phone_number_id
// para acotar por número), el PAC no manda ningún identificador de tenant en la
// URL/headers de este webhook.
const CFDI_WEBHOOK_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;

// Header agnóstico de proveedor: `DualPacCfdiPort.verifyAndNormalizeWebhook`
// intenta el PAC primario y, si falla, el secundario (mismo cuerpo/firma) — el
// caller no necesita (ni puede) saber de antemano cuál de los dos PAC mandó el
// evento, así que no hay un header "x-finkok-signature"/"x-sw-signature"
// separado, solo uno genérico.
const PAC_SIGNATURE_HEADER = "x-pac-signature";

// Eventos que este handler persiste como transición real de estado —
// `CfdiWebhookEvent["type"]`/`DomainCfdiStatus` en port.ts. 'rechazado' (el PAC
// informa que la SOLICITUD de cancelación fue rechazada por el receptor/SAT) es
// un caso deliberadamente DISTINTO: sigue la MISMA decisión de negocio ya tomada
// por `consultar-estado` (cfdi.ts) — "el estado almacenado no se toca para no
// inventar una transición que el motivo de cancelación conocido no sustenta" —
// nunca una lógica paralela nueva inventada aquí. 'en_proceso_cancelacion' no
// debería llegar nunca como estado TERMINAL de un webhook (es el estado DE
// PARTIDA antes de que el SAT resuelva), pero se trata igual por seguridad:
// ack sin persistir, nunca un 500.
function esTransicionPersistible(status: DomainCfdiStatus): boolean {
  return status === "timbrado" || status === "cancelado";
}

export function hotelesCfdiWebhookRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/hoteles/cfdi/webhook", async (c) => {
    // Cuerpo CRUDO (texto), NUNCA `c.req.json()` ya re-serializado — la firma HMAC
    // que verifica `CfdiPort.verifyAndNormalizeWebhook` es sobre los bytes EXACTOS
    // que mandó el PAC, mismo detalle crítico que `billingRoutes`/
    // `restaurantesWhatsAppRoutes` ya documentan para sus propios webhooks.
    const rawBody = await readTextCapped(c.req.raw, MAX_WEBHOOK_BODY_BYTES);
    const signatureHeader = c.req.header(PAC_SIGNATURE_HEADER) ?? undefined;

    let event: Awaited<ReturnType<AppDeps["hotelesCfdiPort"]["verifyAndNormalizeWebhook"]>>;
    try {
      // Orden estricto: verificación de firma (y, dentro de ella, la ausencia de
      // credenciales/secreto -> PortUnavailableError) ANTES de cualquier efecto —
      // ni el rate-limit ni la base de datos se tocan todavía en este punto.
      event = await deps.hotelesCfdiPort.verifyAndNormalizeWebhook(rawBody, signatureHeader);
    } catch (err) {
      if (err instanceof PortUnavailableError) {
        throw Errors.serviceUnavailable(
          "El webhook del PAC de CFDI no está disponible en este entorno: no hay credenciales/secreto de webhook configurados (Finkok/SW Sapien). Esto es esperado sin credenciales reales de un PAC -- configura el secreto de webhook correspondiente para habilitarlo.",
        );
      }
      if (err instanceof WebhookReplayError) {
        // Reintento real del PAC del MISMO evento (idempotencia que cualquier
        // webhook entrante exige, ver InMemoryReplayGuard en
        // packages/mcp-servers/cfdi/src/shared.ts) — ack 2xx SIN volver a tocar
        // la base de datos: nunca se re-ejecuta ningún efecto secundario.
        logEvent(c, "info", "cfdi_pac_webhook_replay", { integration: err.integration, eventId: err.eventId });
        return c.json({ ok: true, procesado: false, motivo: "evento_repetido" });
      }
      if (err instanceof WebhookSignatureError) {
        throw Errors.unauthorized("Firma de webhook del PAC inválida.");
      }
      throw err;
    }

    // Rate-limit evaluado DESPUÉS de verificar la firma (mismo criterio que
    // hoteles/whatsapp.ts): no gastar cupo real en tráfico que ni siquiera prueba
    // venir de un PAC real. A partir de aquí, cualquier request que llegue YA
    // demostró conocer un secreto de webhook válido.
    const rateAllowed = await rateLimit(`conversation:inbound-webhook:${requestActor(c.req.raw)}`, CFDI_WEBHOOK_RATE_LIMIT.max, CFDI_WEBHOOK_RATE_LIMIT.windowMs, {
      category: "conversation:inbound-webhook",
    });
    if (!rateAllowed) throw Errors.tooManyRequests("Demasiadas notificaciones de webhook del PAC de CFDI. Intenta de nuevo en unos minutos.");

    if (!esTransicionPersistible(event.status)) {
      // 'rechazado'/'en_proceso_cancelacion' -- ack 2xx (el PAC no debe
      // reintentar por siempre algo que este handler entiende pero elige no
      // persistir, mismo criterio que consultar-estado), con rastro en log para
      // que el staff se pueda enterar y usar el botón manual de "consultar
      // estado" si hace falta resolverlo.
      logEvent(c, "info", "cfdi_pac_webhook_transicion_no_persistida", { eventId: event.eventId, uuid: event.uuid, status: event.status, tipo: event.type });
      return c.json({ ok: true, procesado: false, motivo: "transicion_no_persistida", estado: event.status });
    }

    // Webhook público/de sistema, sin authMiddleware/dbSession -- abre su propia
    // sesión de sistema (`userId: null`), igual que hoteles/whatsapp.ts.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.hotelesRepo(db);
      const updated = await repo.applyCfdiWebhookStatus(event.uuid, event.status);
      if (!updated) {
        // UUID fiscal desconocido para esta plataforma -- ack 2xx (nunca se debe
        // hacer que el PAC reintente eternamente un UUID que esta plataforma
        // nunca va a reconocer), con rastro en log: podría ser un CFDI de otro
        // sistema/ambiente apuntando por error a este webhook.
        logEvent(c, "warn", "cfdi_pac_webhook_uuid_desconocido", { eventId: event.eventId, uuid: event.uuid, status: event.status });
        return c.json({ ok: true, procesado: false, motivo: "uuid_desconocido" });
      }

      return c.json({ ok: true, procesado: true, id: updated.id, estado: updated.status });
    });
  });

  return app;
}
