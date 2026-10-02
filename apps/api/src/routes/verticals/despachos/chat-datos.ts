// "Chatea con tus datos" -- DESPACHOS. Misma cadena de autorizacion que el dashboard (D-01): JWT -> sesion
// RLS del usuario (`dbSession`) -> membership verificada (`requirePropertyMembership`) -> rol de lectura
// (VER_DASHBOARD_ROLES: admin, contador, auditor, readonly).
//
//   POST /despachos/:propertyId/chat-datos          { question, history? }
//   GET  /despachos/:propertyId/chat-datos/estado   -> { available }
//
// El alcance (organizacion, clientes de la membership, zona horaria, rol) lo fija ESTE handler a partir de la
// sesion verificada; el cuerpo solo aporta la pregunta y el historial (texto), jamas ids ni filtros. Las
// consultas corren con la sesion RLS del usuario, nunca con una de sistema. La logica vive en
// @atiende/agent-core/data-chat (motor) y @atiende/domain-despachos (catalogo): aqui solo se valida entrada.
// Sin migracion nueva: la bitacora (core.data_chat_query_log, 0029) ya acepta la vertical despachos.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { DEFAULT_DATA_CHAT_TIMEZONE, runDataChatTurn } from "@atiende/agent-core/data-chat";
import { VER_DASHBOARD_ROLES, buildDespachosDataChatCatalog } from "@atiende/domain-despachos";
import { parseDataChatRequest } from "../../../data-chat/body.ts";
import { buildDataChatEstado } from "../../../data-chat/estado.ts";
import { DATA_CHAT_NOT_ACTIVATED, respondDataChat, respondDataChatStatic } from "../../../data-chat/ndjson.ts";
import { DATA_CHAT_RETRY_SUFFIX } from "../../../production/llm-models.ts";
import { logUsoDataChat } from "../../../data-chat/uso-log.ts";
import { resolveMembershipPropertyScope } from "../../../data-chat/property-scope.ts";
import { beginTurnPersistence, mountConversacionesRoutes } from "../../../data-chat/conversaciones.ts";
import { DESPACHOS_DATA_CHAT_ROLE } from "../../../production/llm-gateway.ts";
import type { AppDeps } from "../../../deps.ts";

export function despachosChatDatosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/despachos/:propertyId/chat-datos";
  for (const path of [base, `${base}/*`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // La UI lo consulta para mostrar "Pronto" mientras no haya proveedor de IA ni lector configurado.
  app.get(`${base}/estado`, async (c) => {
    assertVerticalRole(c, VER_DASHBOARD_ROLES);
    const available = Boolean(deps.dataChat?.completion && deps.dataChat.despachosReader);
    return c.json(await buildDataChatEstado(deps, c.get("db"), { organizationId: c.get("organizationId"), userId: c.get("userId") }, available));
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, VER_DASHBOARD_ROLES);
    const { question, history, tool, conversationId } = await parseDataChatRequest(c);

    const dataChat = deps.dataChat;
    const completion = dataChat?.completion;
    if (!dataChat || !completion || !dataChat.despachosReader) {
      return respondDataChatStatic(c, DATA_CHAT_NOT_ACTIVATED);
    }

    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const allowedPropertyIds = await resolveMembershipPropertyScope(deps, c, organizationId);
    // `findPropertyConfig` degrada a null (nunca lanza) en la base sin la migracion 012.
    const config = await deps.despachosRepo(db).findPropertyConfig(c.req.param("propertyId") ?? "");

    const userId = c.get("userId");
    const verticalRole = c.get("verticalRole") ?? "";
    // Con `conversationId` el historial sale de la base y el turno se guarda (data-chat/conversaciones.ts); sin el, todo igual.
    const persist = await beginTurnPersistence(deps, db, { conversationId, history, scope: { organizationId, userId, vertical: "despachos" }, propertyId: c.req.param("propertyId") ?? null });
    return respondDataChat(c, deps, async (turnDb, onEvento, signal) =>
      persist.finish(turnDb, question, tool, await runDataChatTurn({
        catalog: buildDespachosDataChatCatalog(dataChat.despachosReader!(turnDb)),
        scope: {
          organizationId,
          userId,
          vertical: "despachos",
          verticalRole,
          allowedPropertyIds,
          timezone: config?.zonaHoraria ?? DEFAULT_DATA_CHAT_TIMEZONE,
        },
        question,
        history: persist.history,
        ...(tool ? { directTool: tool } : {}),
        complete: completion(organizationId, DESPACHOS_DATA_CHAT_ROLE),
        completeRetry: completion(organizationId, `despachos:${DATA_CHAT_RETRY_SUFFIX}`),
        rateLimiter: dataChat.rateLimiter,
        audit: persist.audit(dataChat.audit(turnDb)),
        onEvento,
        signal,
        onUso: logUsoDataChat(c, "despachos"),
        onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", vertical: "despachos", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
      })),
    );
  });

  mountConversacionesRoutes(app, deps, { base, vertical: "despachos", roles: VER_DASHBOARD_ROLES });
  return app;
}
