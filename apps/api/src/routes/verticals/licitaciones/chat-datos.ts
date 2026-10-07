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
import { Hono, type Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { DEFAULT_DATA_CHAT_TIMEZONE, runDataChatTurn } from "@atiende/agent-core/data-chat";
import { LICITACIONES_ROLES, buildLicitacionesDataChatCatalog } from "@atiende/domain-licitaciones";
import { parseDataChatRequest } from "../../../data-chat/body.ts";
import { beginTurnPersistence, mountConversacionesRoutes } from "../../../data-chat/conversaciones.ts";
import { mountReporteRoutes } from "../../../data-chat/reporte-routes.ts";
import { mountAdjuntosRoutes } from "../../../data-chat/adjuntos-routes.ts";
import { buildDataChatEstado } from "../../../data-chat/estado.ts";
import { DATA_CHAT_NOT_ACTIVATED, respondDataChat, respondDataChatStatic } from "../../../data-chat/ndjson.ts";
import { DATA_CHAT_RETRY_SUFFIX } from "../../../production/llm-models.ts";
import { logUsoDataChat } from "../../../data-chat/uso-log.ts";
import { mountPinsRoutes, type PinsTurnContext } from "../../../data-chat/pins.ts";
import { NO_LLM_COMPLETION, auxiliaryTurnOptions, directTurnOptions } from "../../../data-chat/turno.ts";
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

  // Alcance y catalogo de un turno, SIEMPRE desde la membership verificada del request (los usan el POST del chat y los fijados).
  const turnContext = async (c: Context<CoreAuthHonoEnv>): Promise<PinsTurnContext | undefined> => {
    const readerFor = deps.dataChat?.licitacionesReader;
    if (!readerFor) return undefined;
    const organizationId = c.get("organizationId");
    // Zona horaria del negocio (tenant_config, migracion 027): null sin configuracion o en la base sin migrar.
    const timezone = (await readerFor(c.get("db")).organizationTimezone(organizationId)) ?? DEFAULT_DATA_CHAT_TIMEZONE;
    return {
      catalogFor: (d) => buildLicitacionesDataChatCatalog(readerFor(d)),
      scope: { organizationId, userId: c.get("userId"), vertical: "licitaciones", verticalRole: c.get("verticalRole") ?? "", allowedPropertyIds: null, timezone },
    };
  };

  app.post(base, async (c) => {
    assertVerticalRole(c, LICITACIONES_ROLES);
    const { question, history, tool, toolArgs, label, conversationId } = await parseDataChatRequest(c);

    const dataChat = deps.dataChat;
    const completion = dataChat?.completion;
    // La ruta directa (chip/boton, `tool`) no usa modelo: funciona aunque no haya proveedor de IA configurado.
    if (!dataChat || (!completion && !tool) || !dataChat.licitacionesReader) {
      return respondDataChatStatic(c, DATA_CHAT_NOT_ACTIVATED);
    }

    const db = c.get("db");
    const organizationId = c.get("organizationId");
    const turn = (await turnContext(c))!;

    const userId = c.get("userId");
    // Con `conversationId` el historial sale de la base y el turno se guarda (data-chat/conversaciones.ts); sin el, todo igual.
    const persist = await beginTurnPersistence(deps, db, { conversationId, history, tool, signal: c.req.raw.signal, scope: { organizationId, userId, vertical: "licitaciones" }, propertyId: c.req.param("propertyId") ?? null });
    return respondDataChat(c, deps, async (turnDb, onEvento, signal) =>
      persist.finish(turnDb, label ?? question, tool, await runDataChatTurn({
        catalog: turn.catalogFor(turnDb)!,
        scope: turn.scope,
        question,
        history: persist.history,
        ...directTurnOptions(dataChat, tool, toolArgs),
        complete: completion ? completion(organizationId, LICITACIONES_DATA_CHAT_ROLE) : NO_LLM_COMPLETION,
        ...(completion ? { completeRetry: completion(organizationId, `licitaciones:${DATA_CHAT_RETRY_SUFFIX}`) } : {}),
        ...auxiliaryTurnOptions(dataChat, organizationId),
        ...(persist.resumen ? { summary: persist.resumen } : {}),
        rateLimiter: dataChat.rateLimiter,
        audit: persist.audit(dataChat.audit(turnDb)),
        onEvento,
        signal,
        onUso: logUsoDataChat(c, "licitaciones"),
        auditRole: LICITACIONES_DATA_CHAT_ROLE,
        onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", vertical: "licitaciones", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
      })),
      persist.despuesDelCommit,
    );
  });

  mountConversacionesRoutes(app, deps, { base, vertical: "licitaciones", roles: LICITACIONES_ROLES });
  mountPinsRoutes(app, deps, { base, vertical: "licitaciones", roles: LICITACIONES_ROLES, turnContext });
  // Adjuntar archivo (CSV / Excel / PDF): analisis determinista en el servidor, sin guardar el archivo.
  mountAdjuntosRoutes(app, deps, { base, vertical: "licitaciones", roles: LICITACIONES_ROLES, role: LICITACIONES_DATA_CHAT_ROLE });
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
