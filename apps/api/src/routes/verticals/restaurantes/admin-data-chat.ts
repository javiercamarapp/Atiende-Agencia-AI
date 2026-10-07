// "Chatea con tus datos" -- vertical piloto RESTAURANTES. Misma cadena de autorizacion que los KPIs
// (`admin-kpis.ts`): JWT -> sesion RLS del usuario (`dbSession`) -> membership verificada
// (`requirePropertyMembership`) -> rol de gestion (MANAGER_ROLES, excluye repartidor).
//
// El alcance (organizacion, sucursales de la membership, zona horaria, rol) lo fija ESTE handler a
// partir de la sesion verificada; el cuerpo de la peticion solo aporta la pregunta y el historial
// (texto), jamas ids ni filtros. Las consultas corren con la sesion RLS del usuario, nunca con una
// sesion de sistema. Toda la logica de negocio vive en @atiende/agent-core/data-chat (motor) y
// @atiende/domain-restaurantes (catalogo): aqui solo se valida entrada y se serializa la respuesta.
import { Hono, type Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { DEFAULT_DATA_CHAT_TIMEZONE, runDataChatTurn } from "@atiende/agent-core/data-chat";
import { MANAGER_ROLES, buildRestaurantesDataChatCatalog } from "@atiende/domain-restaurantes";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { parseDataChatRequest } from "../../../data-chat/body.ts";
import { beginTurnPersistence, mountConversacionesRoutes } from "../../../data-chat/conversaciones.ts";
import { mountReporteRoutes } from "../../../data-chat/reporte-routes.ts";
import { mountAdjuntosRoutes } from "../../../data-chat/adjuntos-routes.ts";
import { buildDataChatEstado } from "../../../data-chat/estado.ts";
import { DATA_CHAT_NOT_ACTIVATED, respondDataChat, respondDataChatStatic } from "../../../data-chat/ndjson.ts";
import { DATA_CHAT_RETRY_SUFFIX } from "../../../production/llm-models.ts";
import { RESTAURANTES_DATA_CHAT_ROLE } from "../../../production/llm-gateway.ts";
import { logUsoDataChat } from "../../../data-chat/uso-log.ts";
import { mountPinsRoutes, type PinsTurnContext } from "../../../data-chat/pins.ts";
import { NO_LLM_COMPLETION, auxiliaryTurnOptions, directTurnOptions } from "../../../data-chat/turno.ts";

export function restaurantesAdminDataChatRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/chat-datos";
  for (const path of [base, `${base}/*`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // La UI lo consulta para mostrar "Pronto" mientras no haya proveedor de IA configurado.
  app.get(`${base}/estado`, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const available = Boolean(deps.dataChat?.completion);
    return c.json(await buildDataChatEstado(deps, c.get("db"), { organizationId: c.get("organizationId"), userId: c.get("userId") }, available));
  });

  // Alcance y catalogo de un turno, SIEMPRE desde la membership verificada del request (los usan el POST del chat y los fijados).
  const turnContext = async (c: Context<CoreAuthHonoEnv>): Promise<PinsTurnContext | undefined> => {
    const dataChat = deps.dataChat;
    if (!dataChat) return undefined;
    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const allowedPropertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const zona = await deps.restaurantesRepo(db).findBranchZonaHoraria(c.req.param("propertyId") ?? "");
    return {
      catalogFor: (d) => buildRestaurantesDataChatCatalog(dataChat.restaurantesReader(d)),
      scope: {
        organizationId,
        userId: c.get("userId"),
        vertical: "restaurantes",
        verticalRole: c.get("verticalRole") ?? "",
        allowedPropertyIds,
        timezone: zona.zonaHoraria ?? DEFAULT_DATA_CHAT_TIMEZONE,
      },
    };
  };

  app.post(base, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const { question, history, tool, toolArgs, label, conversationId } = await parseDataChatRequest(c);

    const dataChat = deps.dataChat;
    const organizationId = c.get("organizationId");
    const completion = dataChat?.completion;
    // La ruta directa (chip/boton, `tool`) no usa modelo: funciona aunque no haya proveedor de IA configurado.
    if (!dataChat || (!completion && !tool)) {
      return respondDataChatStatic(c, DATA_CHAT_NOT_ACTIVATED);
    }

    const db = c.get("db");
    const turn = (await turnContext(c))!;

    const userId = c.get("userId");
    // Con `conversationId` el historial sale de la base y el turno se guarda (data-chat/conversaciones.ts); sin el, todo igual.
    const persist = await beginTurnPersistence(deps, db, { conversationId, history, tool, signal: c.req.raw.signal, scope: { organizationId, userId, vertical: "restaurantes" }, propertyId: c.req.param("propertyId") ?? null });
    return respondDataChat(c, deps, async (turnDb, onEvento, signal) =>
      persist.finish(turnDb, label ?? question, tool, await runDataChatTurn({
        catalog: turn.catalogFor(turnDb)!,
        scope: turn.scope,
        question,
        history: persist.history,
        ...directTurnOptions(dataChat, tool, toolArgs),
        complete: completion ? completion(organizationId) : NO_LLM_COMPLETION,
        ...(completion ? { completeRetry: completion(organizationId, `restaurantes:${DATA_CHAT_RETRY_SUFFIX}`) } : {}),
        ...auxiliaryTurnOptions(dataChat, organizationId),
        ...(persist.resumen ? { summary: persist.resumen } : {}),
        rateLimiter: dataChat.rateLimiter,
        audit: persist.audit(dataChat.audit(turnDb)),
        onEvento,
        signal,
        onUso: logUsoDataChat(c, "restaurantes"),
        auditRole: RESTAURANTES_DATA_CHAT_ROLE,
        onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
      })),
      persist.despuesDelCommit,
    );
  });

  mountConversacionesRoutes(app, deps, { base, vertical: "restaurantes", roles: MANAGER_ROLES });
  mountPinsRoutes(app, deps, { base, vertical: "restaurantes", roles: MANAGER_ROLES, turnContext });
  // Adjuntar archivo (CSV / Excel / PDF): analisis determinista en el servidor, sin guardar el archivo.
  mountAdjuntosRoutes(app, deps, { base, vertical: "restaurantes", roles: MANAGER_ROLES, role: RESTAURANTES_DATA_CHAT_ROLE });
  // CHAT-14: reporte PDF de un mensaje guardado, con el mismo alcance que el chat.
  mountReporteRoutes(app, deps, {
    base,
    vertical: "restaurantes",
    roles: MANAGER_ROLES,
    resolve: async (c, db) => {
      const dataChat = deps.dataChat;
      if (!dataChat) return undefined;
      const organizationId = c.get("organizationId");
      const allowedPropertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, null);
      const zona = await deps.restaurantesRepo(db).findBranchZonaHoraria(c.req.param("propertyId") ?? "");
      return {
        catalog: buildRestaurantesDataChatCatalog(dataChat.restaurantesReader(db)),
        scope: { organizationId, userId: c.get("userId"), vertical: "restaurantes", verticalRole: c.get("verticalRole") ?? "", allowedPropertyIds, timezone: zona.zonaHoraria ?? DEFAULT_DATA_CHAT_TIMEZONE },
      };
    },
  });
  return app;
}
