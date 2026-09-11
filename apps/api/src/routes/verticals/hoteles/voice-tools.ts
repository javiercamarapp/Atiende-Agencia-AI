// Fase 2 hoteles §1 — Server Tools HTTP reales para el agente de voz de ElevenLabs.
// Mismo patrón que apps/api/src/routes/verticals/restaurantes/voice-tools.ts: sub-Hono
// propio, SIN `authMiddleware`/`originAllowed` para las rutas de tool — ElevenLabs no
// manda `Origin` ni `Authorization`, solo el secreto dedicado
// `x-atiende-tool-secret`. NO se monta sobre `@atiende/voice-gateway` (esa capa es
// config/sesión del agente — signed URL, listVoices — una superficie distinta de
// "recibir el webhook de tool call durante una llamada en curso", ver diseño §1).
//
// Divergencia deliberada de restaurantes (diseño §1/§5.1): el secreto NO es
// compartido de plataforma, es dedicado POR PROPERTY
// (`hoteles.voice_agent_config.tool_webhook_secret`) — el origen real de hoteles
// documenta el aislamiento por tenant como el eje de seguridad central de este
// vertical. Por eso este archivo también expone el endpoint de rotación
// (autenticado, solo ADMIN_ROLES) además de las 2 Server Tools sin auth.
//
// Catálogo reducido a 2 tools (diseño §5.2): crear_ticket_huesped_fnb (reutiliza
// fnbAllergyGuard + insertFnbOrder — REQ-AB-004 sin excepción) y
// registrar_contacto_no_operativo. Housekeeping/mantenimiento/dinero/quotes quedan
// deliberadamente fuera (mismo límite de seguridad que el catálogo real del origen,
// aplicado a lo que hoy existe en domain-hoteles).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ADMIN_ROLES, consumeRateLimit, registerContactoNoOperativo, resolveAllergyDeclared } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { constantTimeEqual, readJsonCapped, requestActor } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Secreto dedicado POR PROPERTY (diseño §1/§5.1) — a diferencia de
 * `requireVoiceToolSecret` de restaurantes (un solo valor de plataforma en
 * `deps.env`), aquí cada property tiene el suyo en `hoteles.voice_agent_config`,
 * verificado en tiempo constante con la misma primitiva que el resto del app
 * (`constantTimeEqual`). */
async function requireVoiceAgentConfig(deps: AppDeps, propertyId: string, req: Request): Promise<{ organizationId: string }> {
  const config = await deps.hotelesRepo.findVoiceAgentConfig(propertyId);
  if (!config || !config.enabled) throw Errors.serviceUnavailable("El agente de voz no está configurado o está deshabilitado para esta property.");
  if (!constantTimeEqual(req.headers.get("x-atiende-tool-secret"), config.toolWebhookSecret)) throw Errors.unauthorized();
  return { organizationId: config.organizationId };
}

interface CrearTicketFnbBody {
  readonly mensaje?: unknown;
  readonly habitacion?: unknown;
  readonly alergia_declarada?: unknown;
}

interface ContactoNoOperativoBody {
  readonly motivo?: unknown;
  readonly resumen?: unknown;
  readonly telefono?: unknown;
}

interface RotateVoiceConfigBody {
  readonly enabled?: unknown;
}

export function hotelesVoiceToolsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // §1 — POST /v1/hoteles/:propertyId/voz/tickets-fnb (crear_ticket_huesped_fnb).
  // Reusa 100% fnbAllergyGuard.resolveAllergyDeclared + repo.insertFnbOrder — mismo
  // camino que POST /hoteles/:propertyId/pedidos-fnb, pero sin sesión de staff
  // (actor system:voz, createdBy:null). NUNCA responde afirmando que el platillo es
  // seguro — eso sigue exigiendo confirmación humana de cocina (REQ-AB-004).
  app.post("/v1/hoteles/:propertyId/voz/tickets-fnb", async (c) => {
    const propertyId = c.req.param("propertyId");
    const { organizationId } = await requireVoiceAgentConfig(deps, propertyId, c.req.raw);

    const limited = await consumeRateLimit(deps.hotelesRepo, "voice-tickets-fnb", requestActor(c.req.raw, propertyId), 60, 60);
    if (!limited.allowed) throw Errors.tooManyRequests();

    const body = await readJsonCapped<CrearTicketFnbBody>(c.req.raw, 8 * 1024);
    const mensaje = typeof body.mensaje === "string" ? body.mensaje.trim() : "";
    if (!mensaje || mensaje.length > 1000) throw Errors.validation("mensaje es requerido (máximo 1000 caracteres).");
    const habitacion = typeof body.habitacion === "string" && body.habitacion.trim() ? body.habitacion.trim().slice(0, 50) : null;
    const notes = habitacion ? `Habitación declarada por el huésped vía voz: ${habitacion}` : null;

    const { allergyDeclared, declaredVia } = resolveAllergyDeclared({
      structuredFlag: body.alergia_declarada === true,
      freeTextFields: [mensaje, notes],
    });

    const order = await deps.hotelesRepo.insertFnbOrder({
      organizationId,
      propertyId,
      roomId: null,
      items: [{ nombre: mensaje }],
      notes,
      allergyDeclared,
      allergyDeclaredVia: declaredVia,
      createdBy: null, // actor system:voz — sin staff humano logueado.
    });

    return c.json({
      id: order.id,
      alergiaDeclarada: order.allergyDeclared,
      mensaje: order.allergyDeclared
        ? "Registramos tu pedido y tu alergia/restricción alimentaria. La cocina va a revisarlo antes de prepararlo."
        : "Registramos tu pedido, la cocina lo va a preparar.",
    });
  });

  // §1 — POST /v1/hoteles/:propertyId/voz/contacto-no-operativo
  // (registrar_contacto_no_operativo) — mismo tool que usa el agente de WhatsApp,
  // expuesto también por voz para que un mensaje que no sea F&B siempre quede
  // registrado para seguimiento humano.
  app.post("/v1/hoteles/:propertyId/voz/contacto-no-operativo", async (c) => {
    const propertyId = c.req.param("propertyId");
    const { organizationId } = await requireVoiceAgentConfig(deps, propertyId, c.req.raw);

    const limited = await consumeRateLimit(deps.hotelesRepo, "voice-contacto-no-operativo", requestActor(c.req.raw, propertyId), 60, 60);
    if (!limited.allowed) throw Errors.tooManyRequests();

    const body = await readJsonCapped<ContactoNoOperativoBody>(c.req.raw, 4 * 1024);
    const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
    if (!motivo || motivo.length > 500) throw Errors.validation("motivo es requerido (máximo 500 caracteres).");

    const contacto = await registerContactoNoOperativo(deps.hotelesRepo, {
      organizationId,
      propertyId,
      guestPhone: typeof body.telefono === "string" ? body.telefono.trim().slice(0, 32) : null,
      guestName: null,
      reason: motivo,
      message: typeof body.resumen === "string" ? body.resumen.trim().slice(0, 1000) : null,
      source: "voice",
    });

    return c.json({ id: contacto.id, ok: true });
  });

  // Endpoint de rotación (diseño §1/§5.1) — SÍ requiere sesión de staff, solo
  // ADMIN_ROLES (owner/gm): rota o crea el secreto dedicado de voz de esta property.
  // El secreto nuevo se genera server-side (nunca se acepta uno mandado por el
  // cliente) y se devuelve UNA sola vez en la respuesta — igual criterio que
  // cualquier rotación de API key real.
  app.use("/hoteles/:propertyId/voz/config", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.post("/hoteles/:propertyId/voz/config", async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<RotateVoiceConfigBody>(c.req.raw, 1 * 1024);
    const enabled = raw.enabled !== false;
    const newSecret = randomUUID() + randomUUID();
    await deps.hotelesRepo.upsertVoiceAgentConfig(propertyId, organizationId, newSecret, enabled);
    return c.json({ toolWebhookSecret: newSecret, enabled });
  });

  return app;
}
