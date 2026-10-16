// «Probar agente» del panel (cuenta real): POST /v1/restaurantes/:propertyId/admin/agente-whatsapp/preview/mensaje.
// El dueno conversa con el MISMO agente real de WhatsApp (`deps.turnHandler`, mismo gateway LLM, presupuesto y kill switch) pero en
// modo `preview` fijado por el SERVIDOR: lecturas y maquina de estados del pedido reales; `crear_pedido` devuelve un pedido
// simulado PRUEBA-xxxx y NINGUNA herramienta escribe pedidos, clientes, comandas, avisos ni correos (ver agent-tools/registry.ts).
//
// Sin estado en el servidor: el cliente manda el historial de SU prueba y la conversacion NO se persiste (no pasa por
// `handleInboundWhatsAppMessage`: ni ledger de mensajes, ni conversacion, ni consentimiento), asi que por construccion no puede
// aparecer en la bandeja de conversaciones, en los KPI de WhatsApp ni en las alertas, y no hay nada que purgar. Lo unico que queda es la
// fila de la maquina de estados del pedido (clave `wa:<telefono ficticio de la sesion>`, con TTL propio) y el consumo del gateway LLM.
//
// Autorizacion: owner/admin (`STAFF_INVITE_ROLES`) + membership de la sucursal (como el resto de `admin/*`). Topes: por staff y por
// organizacion/dia (costo). Sin proveedor LLM: 503 honesto "requiere OPENROUTER_API_KEY"; nunca respuestas por palabras clave.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { DAY_SECONDS, STAFF_INVITE_ROLES, getCustomerDetailById, telefonoFicticioPreview, validarConfigAgenteWhatsapp } from "@atiende/domain-restaurantes";
import type { ConversationMessage, WhatsAppAgentConfigInput } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { consumirTopesEnSesionDeSistema } from "./rate-limit-sistema.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AGENTE_PREVIEW_LIMITES = { maxMensajes: 40, maxCaracteresMensaje: 1000, porStaffPor10Min: 40, porOrganizacionPorDia: 400 } as const;

interface CuerpoPreview {
  readonly sesionId?: unknown;
  readonly mensajes?: unknown;
  readonly clienteSimuladoId?: unknown;
  readonly borrador?: unknown;
}

function limpiar(texto: string): string {
  // eslint-disable-next-line no-control-regex
  return texto.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
}

/** Historial de la prueba: alterna usuario/agente, empieza y termina con un mensaje del usuario. */
function parseMensajes(raw: unknown): readonly ConversationMessage[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > AGENTE_PREVIEW_LIMITES.maxMensajes) {
    throw Errors.validation(`mensajes: se esperaba una lista de 1 a ${AGENTE_PREVIEW_LIMITES.maxMensajes} mensajes.`);
  }
  const out: ConversationMessage[] = raw.map((m) => {
    const e = m as { rol?: unknown; texto?: unknown } | null;
    if (!e || (e.rol !== "usuario" && e.rol !== "agente") || typeof e.texto !== "string") throw Errors.validation('mensajes: cada mensaje lleva rol ("usuario" o "agente") y texto.');
    const texto = limpiar(e.texto);
    if (!texto || texto.length > AGENTE_PREVIEW_LIMITES.maxCaracteresMensaje) throw Errors.validation(`mensajes: cada texto lleva de 1 a ${AGENTE_PREVIEW_LIMITES.maxCaracteresMensaje} caracteres.`);
    return { role: e.rol === "usuario" ? "user" : "assistant", content: texto };
  });
  if (out[0]!.role !== "user" || out[out.length - 1]!.role !== "user") throw Errors.validation("mensajes: el historial empieza y termina con un mensaje del usuario.");
  for (let i = 1; i < out.length; i++) if (out[i]!.role === out[i - 1]!.role) throw Errors.validation("mensajes: los mensajes alternan usuario y agente.");
  return out;
}

export function restaurantesAgentePreviewRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/agente-whatsapp/preview/mensaje";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post(path, async (c) => {
    c.header("Cache-Control", "no-store");
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    await resolveEffectivePropertyIds(deps, c, organizationId, propertyId);

    const body = await readJsonCapped<CuerpoPreview>(c.req.raw, 48 * 1024);
    if (typeof body.sesionId !== "string" || !UUID_RE.test(body.sesionId)) throw Errors.validation("sesionId: se esperaba un UUID.");
    const mensajes = parseMensajes(body.mensajes);
    if (body.clienteSimuladoId !== undefined && body.clienteSimuladoId !== null && (typeof body.clienteSimuladoId !== "string" || !UUID_RE.test(body.clienteSimuladoId))) {
      throw Errors.validation("clienteSimuladoId: se esperaba un UUID.");
    }
    let borrador: WhatsAppAgentConfigInput | null = null;
    if (body.borrador !== undefined && body.borrador !== null) {
      if (typeof body.borrador !== "object" || Array.isArray(body.borrador)) throw Errors.validation("borrador: se esperaba un objeto.");
      const validada = validarConfigAgenteWhatsapp(body.borrador as Parameters<typeof validarConfigAgenteWhatsapp>[0]);
      if (!validada.ok) throw Errors.validation(validada.error);
      borrador = validada.valor;
    }

    // Sin proveedor LLM no hay agente: estado honesto, nunca una respuesta por palabras clave ni un turno de "solo acuse de recibo".
    if (deps.llmGateway === undefined) {
      return c.json({ code: "agente_no_disponible", message: "No disponible: requiere OPENROUTER_API_KEY. Sin un proveedor de IA configurado el agente no puede responder." }, 503);
    }

    const repo = deps.restaurantesRepo(c.get("db"));
    const staffId = c.get("userId");
    // `consume_api_rate_limit` es de SOLO sistema (auth.uid() nulo): los dos topes se consumen en una sesion de sistema propia, no en la
    // del staff (en ella la funcion lanzaba 42501 => «Error interno» al primer mensaje). El actor sigue siendo el staff del JWT.
    const agotado = await consumirTopesEnSesionDeSistema(deps, [
      { scope: "agente-preview-staff", actor: requestActor(c.req.raw, staffId), maxRequests: AGENTE_PREVIEW_LIMITES.porStaffPor10Min, windowSeconds: 600 },
      { scope: "agente-preview-org", actor: organizationId, maxRequests: AGENTE_PREVIEW_LIMITES.porOrganizacionPorDia, windowSeconds: DAY_SECONDS },
    ]);
    if (agotado === 0) throw Errors.tooManyRequests();
    if (agotado === 1) return c.json({ code: "agente_preview_tope", message: "La prueba del agente alcanzó su tope de mensajes de hoy. Inténtelo mañana." }, 429);

    // Cliente conocido simulado: debe ser de ESTA organizacion (otra organizacion o inexistente => 404, sin distinguir).
    let customer: Awaited<ReturnType<typeof getCustomerDetailById>> = { isNew: true };
    const clienteSimuladoId = typeof body.clienteSimuladoId === "string" ? body.clienteSimuladoId : null;
    if (clienteSimuladoId) {
      customer = await getCustomerDetailById(repo, organizationId, clienteSimuladoId);
      if (!customer) throw Errors.notFound("Cliente no encontrado.");
    }

    const turno = await deps.turnHandler.handleInboundMessage({
      organizationId,
      phone: telefonoFicticioPreview(body.sesionId),
      messages: mensajes,
      customer: customer ?? { isNew: true },
      propertyId,
      modo: "preview",
      previewCustomerId: clienteSimuladoId,
      configBorrador: borrador,
    });
    logEvent(c, "info", "restaurantes_admin_agente_preview_mensaje", { actorUserId: staffId, organizationId, propertyId, conBorrador: borrador !== null, clienteSimulado: clienteSimuladoId !== null });
    return c.json({ respuesta: turno.reply, escalado: turno.escalacion !== undefined, pedidoSimulado: turno.pedidoSimulado ?? null });
  });

  return app;
}
