// "Chatea con tus datos" -- LICITACIONES. Misma cadena de autorizacion que el resto del vertical: JWT -> sesion
// RLS del usuario (`dbSession`) -> membership verificada (`requirePropertyMembership`) -> rol de la vertical
// (cualquier rol: la lectura de convocatorias, plazos, propuestas, fallos y contratos ya es de todo miembro de
// la organizacion por RLS `licitaciones.can_access_org`; el chat no amplia lo que cada rol ya puede leer).
//
//   POST /licitaciones/:propertyId/chat-datos          { question, history? }
//   GET  /licitaciones/:propertyId/chat-datos/estado   -> { available }
//
// El alcance es la ORGANIZACION del usuario (licitaciones no tiene sucursales ni clientes): lo fija ESTE
// handler a partir de la sesion verificada; el cuerpo solo aporta la pregunta y el historial. Las consultas
// corren con la sesion RLS del usuario, nunca con una de sistema. Sin migracion nueva: la bitacora
// (core.data_chat_query_log, 0029) ya acepta la vertical licitaciones.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { DEFAULT_DATA_CHAT_TIMEZONE, runDataChatTurn } from "@atiende/agent-core/data-chat";
import { LICITACIONES_ROLES, buildLicitacionesDataChatCatalog } from "@atiende/domain-licitaciones";
import { parseDataChatBody } from "../../../data-chat/body.ts";
import { Errors } from "../../../errors.ts";
import { LICITACIONES_DATA_CHAT_ROLE } from "../../../production/llm-gateway.ts";
import type { AppDeps } from "../../../deps.ts";

export function licitacionesChatDatosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/chat-datos";
  for (const path of [base, `${base}/*`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // La UI lo consulta para mostrar "Pronto" mientras no haya proveedor de IA ni lector configurado.
  app.get(`${base}/estado`, (c) => {
    assertVerticalRole(c, LICITACIONES_ROLES);
    return c.json({ available: Boolean(deps.dataChat?.completion && deps.dataChat.licitacionesReader) });
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, LICITACIONES_ROLES);
    const raw: unknown = await c.req.json().catch(() => {
      throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
    });
    const { question, history } = parseDataChatBody(raw);

    const dataChat = deps.dataChat;
    const completion = dataChat?.completion;
    if (!dataChat || !completion || !dataChat.licitacionesReader) {
      return c.json({ status: "unavailable", text: "El asistente de datos todavía no está activado para tu cuenta. Tus tableros siguen disponibles.", blocks: [], sources: [], toolsUsed: [] });
    }

    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const reader = dataChat.licitacionesReader(db);
    // Zona horaria del negocio (tenant_config, migracion 027): null sin configuracion o en la base sin migrar.
    const timezone = (await reader.organizationTimezone(organizationId)) ?? DEFAULT_DATA_CHAT_TIMEZONE;

    const answer = await runDataChatTurn({
      catalog: buildLicitacionesDataChatCatalog(reader),
      scope: {
        organizationId,
        userId: c.get("userId"),
        vertical: "licitaciones",
        verticalRole: c.get("verticalRole") ?? "",
        allowedPropertyIds: null,
        timezone,
      },
      question,
      history,
      complete: completion(organizationId, LICITACIONES_DATA_CHAT_ROLE),
      rateLimiter: dataChat.rateLimiter,
      audit: dataChat.audit(db),
      onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", vertical: "licitaciones", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
    });
    return c.json(answer);
  });

  return app;
}
