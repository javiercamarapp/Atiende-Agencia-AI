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
import { parseDataChatRequest } from "../../../data-chat/body.ts";
import { beginTurnPersistence, mountConversacionesRoutes } from "../../../data-chat/conversaciones.ts";
import { mountReporteRoutes } from "../../../data-chat/reporte-routes.ts";
import { buildDataChatEstado } from "../../../data-chat/estado.ts";
import { DATA_CHAT_NOT_ACTIVATED, respondDataChat, respondDataChatStatic } from "../../../data-chat/ndjson.ts";
import { DATA_CHAT_RETRY_SUFFIX } from "../../../production/llm-models.ts";
import { logUsoDataChat } from "../../../data-chat/uso-log.ts";
import { LICITACIONES_DATA_CHAT_ROLE } from "../../../production/llm-gateway.ts";
import type { AppDeps } from "../../../deps.ts";

export function licitacionesChatDatosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/chat-datos";
  for (const path of [base, `${base}/*`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // La UI lo consulta para mostrar "Pronto" mientras no haya proveedor de IA ni lector configurado.
  app.get(`${base}/estado`, async (c) => {
    assertVerticalRole(c, LICITACIONES_ROLES);
    const available = Boolean(deps.dataChat?.completion && deps.dataChat.licitacionesReader);
    return c.json(await buildDataChatEstado(deps, c.get("db"), { organizationId: c.get("organizationId"), userId: c.get("userId") }, available));
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, LICITACIONES_ROLES);
    const { question, history, tool, conversationId } = await parseDataChatRequest(c);

    const dataChat = deps.dataChat;
    const completion = dataChat?.completion;
    if (!dataChat || !completion || !dataChat.licitacionesReader) {
      return respondDataChatStatic(c, DATA_CHAT_NOT_ACTIVATED);
    }

    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const readerFor = dataChat.licitacionesReader;
    const reader = readerFor(db);
    // Zona horaria del negocio (tenant_config, migracion 027): null sin configuracion o en la base sin migrar.
    const timezone = (await reader.organizationTimezone(organizationId)) ?? DEFAULT_DATA_CHAT_TIMEZONE;

    const userId = c.get("userId");
    const verticalRole = c.get("verticalRole") ?? "";
    // Con `conversationId` el historial sale de la base y el turno se guarda (data-chat/conversaciones.ts); sin el, todo igual.
    const persist = await beginTurnPersistence(deps, db, { conversationId, history, scope: { organizationId, userId, vertical: "licitaciones" }, propertyId: c.req.param("propertyId") ?? null });
    return respondDataChat(c, deps, async (turnDb, onEvento, signal) =>
      persist.finish(turnDb, question, tool, await runDataChatTurn({
        catalog: buildLicitacionesDataChatCatalog(readerFor(turnDb)),
        scope: {
          organizationId,
          userId,
          vertical: "licitaciones",
          verticalRole,
          allowedPropertyIds: null,
          timezone,
        },
        question,
        history: persist.history,
        ...(tool ? { directTool: tool } : {}),
        complete: completion(organizationId, LICITACIONES_DATA_CHAT_ROLE),
        completeRetry: completion(organizationId, `licitaciones:${DATA_CHAT_RETRY_SUFFIX}`),
        rateLimiter: dataChat.rateLimiter,
        audit: persist.audit(dataChat.audit(turnDb)),
        onEvento,
        signal,
        onUso: logUsoDataChat(c, "licitaciones"),
        onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", vertical: "licitaciones", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
      })),
    );
  });

  mountConversacionesRoutes(app, deps, { base, vertical: "licitaciones", roles: LICITACIONES_ROLES });
  // CHAT-14: reporte PDF de un mensaje guardado, con el mismo alcance que el chat (la organizacion).
  mountReporteRoutes(app, deps, {
    base,
    vertical: "licitaciones",
    roles: LICITACIONES_ROLES,
    resolve: async (c, db) => {
      const readerFor = deps.dataChat?.licitacionesReader;
      if (!readerFor) return undefined;
      const organizationId = c.get("organizationId");
      const reader = readerFor(db);
      // Zona horaria del negocio (tenant_config, migracion 027): null sin configuracion o en la base sin migrar.
      const timezone = (await reader.organizationTimezone(organizationId)) ?? DEFAULT_DATA_CHAT_TIMEZONE;
      return {
        catalog: buildLicitacionesDataChatCatalog(reader),
        scope: { organizationId, userId: c.get("userId"), vertical: "licitaciones", verticalRole: c.get("verticalRole") ?? "", allowedPropertyIds: null, timezone },
      };
    },
  });
  return app;
}
