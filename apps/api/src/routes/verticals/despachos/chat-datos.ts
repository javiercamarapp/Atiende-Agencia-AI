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
import { Hono, type Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { DEFAULT_DATA_CHAT_TIMEZONE, runDataChatTurn } from "@atiende/agent-core/data-chat";
import { VER_DASHBOARD_ROLES, buildDespachosDataChatCatalog } from "@atiende/domain-despachos";
import { parseDataChatRequest } from "../../../data-chat/body.ts";
import { buildDataChatEstado } from "../../../data-chat/estado.ts";
import { DATA_CHAT_NOT_ACTIVATED, respondDataChat, respondDataChatStatic } from "../../../data-chat/ndjson.ts";
import { DATA_CHAT_RETRY_SUFFIX } from "../../../production/llm-models.ts";
import { logUsoDataChat } from "../../../data-chat/uso-log.ts";
import { mountPinsRoutes, type PinsTurnContext } from "../../../data-chat/pins.ts";
import { NO_LLM_COMPLETION, auxiliaryTurnOptions, directTurnOptions } from "../../../data-chat/turno.ts";
import { resolveMembershipPropertyScope } from "../../../data-chat/property-scope.ts";
import { beginTurnPersistence, mountConversacionesRoutes } from "../../../data-chat/conversaciones.ts";
import { mountReporteRoutes } from "../../../data-chat/reporte-routes.ts";
import { mountAdjuntosRoutes } from "../../../data-chat/adjuntos-routes.ts";
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

  // Alcance y catalogo de un turno, SIEMPRE desde la membership verificada del request (los usan el POST del chat y los fijados).
  const turnContext = async (c: Context<CoreAuthHonoEnv>): Promise<PinsTurnContext | undefined> => {
    const readerFor = deps.dataChat?.despachosReader;
    if (!readerFor) return undefined;
    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const allowedPropertyIds = await resolveMembershipPropertyScope(deps, c, organizationId);
    // `findPropertyConfig` degrada a null (nunca lanza) en la base sin la migracion 012.
    const config = await deps.despachosRepo(db).findPropertyConfig(c.req.param("propertyId") ?? "");
    return {
      catalogFor: (d) => buildDespachosDataChatCatalog(readerFor(d)),
      scope: {
        organizationId,
        userId: c.get("userId"),
        vertical: "despachos",
        verticalRole: c.get("verticalRole") ?? "",
        allowedPropertyIds,
        timezone: config?.zonaHoraria ?? DEFAULT_DATA_CHAT_TIMEZONE,
      },
    };
  };

  app.post(base, async (c) => {
    assertVerticalRole(c, VER_DASHBOARD_ROLES);
    const { question, history, tool, toolArgs, label, conversationId } = await parseDataChatRequest(c);

    const dataChat = deps.dataChat;
    const completion = dataChat?.completion;
    // La ruta directa (chip/boton, `tool`) no usa modelo: funciona aunque no haya proveedor de IA configurado.
    if (!dataChat || (!completion && !tool) || !dataChat.despachosReader) {
      return respondDataChatStatic(c, DATA_CHAT_NOT_ACTIVATED);
    }

    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const turn = (await turnContext(c))!;

    const userId = c.get("userId");
    // Con `conversationId` el historial sale de la base y el turno se guarda (data-chat/conversaciones.ts); sin el, todo igual.
    const persist = await beginTurnPersistence(deps, db, { conversationId, history, tool, signal: c.req.raw.signal, scope: { organizationId, userId, vertical: "despachos" }, propertyId: c.req.param("propertyId") ?? null });
    return respondDataChat(c, deps, async (turnDb, onEvento, signal) =>
      persist.finish(turnDb, label ?? question, tool, await runDataChatTurn({
        catalog: turn.catalogFor(turnDb)!,
        scope: turn.scope,
        question,
        history: persist.history,
        ...directTurnOptions(dataChat, tool, toolArgs),
        complete: completion ? completion(organizationId, DESPACHOS_DATA_CHAT_ROLE) : NO_LLM_COMPLETION,
        ...(completion ? { completeRetry: completion(organizationId, `despachos:${DATA_CHAT_RETRY_SUFFIX}`) } : {}),
        ...auxiliaryTurnOptions(dataChat, organizationId),
        ...(persist.resumen ? { summary: persist.resumen } : {}),
        rateLimiter: dataChat.rateLimiter,
        audit: persist.audit(dataChat.audit(turnDb)),
        onEvento,
        signal,
        onUso: logUsoDataChat(c, "despachos"),
        auditRole: DESPACHOS_DATA_CHAT_ROLE,
        onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", vertical: "despachos", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
      })),
      persist.despuesDelCommit,
    );
  });

  mountConversacionesRoutes(app, deps, { base, vertical: "despachos", roles: VER_DASHBOARD_ROLES });
  mountPinsRoutes(app, deps, { base, vertical: "despachos", roles: VER_DASHBOARD_ROLES, turnContext });
  // Adjuntar archivo (CSV / Excel / PDF): analisis determinista en el servidor, sin guardar el archivo.
  mountAdjuntosRoutes(app, deps, { base, vertical: "despachos", roles: VER_DASHBOARD_ROLES, role: DESPACHOS_DATA_CHAT_ROLE });
  // CHAT-14: reporte PDF de un mensaje guardado, con el mismo alcance que el chat.
  mountReporteRoutes(app, deps, {
    base,
    vertical: "despachos",
    roles: VER_DASHBOARD_ROLES,
    resolve: async (c, db) => {
      const reader = deps.dataChat?.despachosReader;
      if (!reader) return undefined;
      const organizationId = c.get("organizationId");
      const allowedPropertyIds = await resolveMembershipPropertyScope(deps, c, organizationId);
      // `findPropertyConfig` degrada a null (nunca lanza) en la base sin la migracion 012.
      const config = await deps.despachosRepo(db).findPropertyConfig(c.req.param("propertyId") ?? "");
      return {
        catalog: buildDespachosDataChatCatalog(reader(db)),
        scope: { organizationId, userId: c.get("userId"), vertical: "despachos", verticalRole: c.get("verticalRole") ?? "", allowedPropertyIds, timezone: config?.zonaHoraria ?? DEFAULT_DATA_CHAT_TIMEZONE },
      };
    },
  });
  return app;
}
