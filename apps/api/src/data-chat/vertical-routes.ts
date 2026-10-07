// Rutas de "Chatea con tus datos" para las verticales POR PROPIEDAD (hoteles, rentas, citas): misma cadena de
// autorizacion que la ruta de restaurantes -- JWT -> sesion RLS del usuario (`dbSession`) -> membership verificada
// (`requirePropertyMembership`) -> rol permitido de la vertical -- y el MISMO motor (`runDataChatTurn`).
//
// El alcance (organizacion, propiedades de la membership, zona horaria, rol) lo fija ESTE codigo a partir de la
// sesion verificada; el cuerpo de la peticion solo aporta la pregunta y el historial (texto), jamas ids ni
// filtros. Las consultas corren con la sesion RLS del usuario, nunca con una de sistema. La logica de negocio
// vive en @atiende/agent-core/data-chat (motor) y en el catalogo del dominio (domain-hoteles / domain-rentas).
import { Hono, type Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { runDataChatTurn, type DataChatCatalog } from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { AppDeps } from "../deps.ts";
import { DATA_CHAT_RETRY_SUFFIX } from "../production/llm-models.ts";
import { logUsoDataChat } from "./uso-log.ts";
import { parseDataChatRequest } from "./body.ts";
import { buildDataChatEstado } from "./estado.ts";
import { DATA_CHAT_NOT_ACTIVATED, respondDataChat, respondDataChatStatic } from "./ndjson.ts";
import { resolveMembershipPropertyScope } from "./property-scope.ts";
import { beginTurnPersistence, mountConversacionesRoutes } from "./conversaciones.ts";
import { mountPinsRoutes, type PinsTurnContext } from "./pins.ts";
import { NO_LLM_COMPLETION, auxiliaryTurnOptions, directTurnOptions } from "./turno.ts";
import { mountReporteRoutes } from "./reporte-routes.ts";
import { mountAdjuntosRoutes } from "./adjuntos-routes.ts";

export interface VerticalDataChatConfig {
  /** "hoteles" | "rentas" | "citas": prefijo de ruta (`/hoteles/:propertyId/chat-datos`) y etiqueta del alcance. */
  readonly vertical: "hoteles" | "rentas" | "citas";
  /** Roles de la vertical que pueden usar el chat (la RLS sigue siendo la autoridad final). */
  readonly roles: readonly string[];
  /** Catalogo ya ligado al lector de la sesion RLS del usuario; undefined = esta vertical no esta cableada. */
  readonly catalog: (deps: AppDeps, db: TenantDbSession) => DataChatCatalog | undefined;
  /** Rol de gateway de esta vertical (`<vertical>:data_chat`: apagable y con registro de uso propio). */
  readonly role: string;
  /** Zona horaria IANA ya resuelta de la propiedad activa (`organizationId` = la de la sesion verificada, para las
   *  verticales que caen a la zona de la organizacion cuando la propiedad no tiene una propia). */
  readonly timezone: (deps: AppDeps, db: TenantDbSession, propertyId: string, organizationId: string) => Promise<string>;
}

export function verticalDataChatRoutes(deps: AppDeps, cfg: VerticalDataChatConfig): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = `/${cfg.vertical}/:propertyId/chat-datos`;
  for (const path of [base, `${base}/*`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // La UI lo consulta para mostrar "Pronto" mientras no haya proveedor de IA configurado (o el rol no sirva).
  app.get(`${base}/estado`, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const db = c.get("db");
    const available = Boolean(deps.dataChat?.completion && cfg.catalog(deps, db));
    return c.json(await buildDataChatEstado(deps, db, { organizationId: c.get("organizationId"), userId: c.get("userId") }, available));
  });

  // Alcance y catalogo de un turno, SIEMPRE desde la membership verificada del request (los usa el POST del chat y los fijados).
  const turnContext = async (c: Context<CoreAuthHonoEnv>): Promise<PinsTurnContext | undefined> => {
    const db = c.get("db");
    if (!cfg.catalog(deps, db)) return undefined;
    const organizationId = c.get("organizationId");
    // Alcance por membership: nunca se ensancha mas alla de las propiedades de este usuario (mismo criterio que
    // restaurantes/admin-scope.ts). Si la membership completa no aparece, cae a la unica propiedad ya verificada.
    const allowedPropertyIds = await resolveMembershipPropertyScope(deps, c, organizationId);
    const timezone = await cfg.timezone(deps, db, c.req.param("propertyId") ?? "", organizationId);
    return {
      catalogFor: (d) => cfg.catalog(deps, d),
      scope: { organizationId, userId: c.get("userId"), vertical: cfg.vertical, verticalRole: c.get("verticalRole") ?? "", allowedPropertyIds, timezone },
    };
  };

  app.post(base, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const { question, history, tool, toolArgs, label, conversationId } = await parseDataChatRequest(c);

    const dataChat = deps.dataChat;
    const organizationId = c.get("organizationId");
    const db = c.get("db");
    const completion = dataChat?.completion;
    // La ruta directa (chip/boton, `tool`) no usa modelo: funciona aunque no haya proveedor de IA configurado.
    const turn = dataChat && (completion || tool) ? await turnContext(c) : undefined;
    if (!dataChat || !turn) {
      return respondDataChatStatic(c, DATA_CHAT_NOT_ACTIVATED);
    }

    const userId = c.get("userId");
    const propertyId = c.req.param("propertyId") ?? "";
    // Con `conversationId` el historial sale de la base y el turno se guarda (conversaciones.ts); sin el, todo igual.
    const persist = await beginTurnPersistence(deps, db, { conversationId, history, tool, signal: c.req.raw.signal, scope: { organizationId, userId, vertical: cfg.vertical }, propertyId });
    return respondDataChat(c, deps, async (turnDb, onEvento, signal) =>
      persist.finish(turnDb, label ?? question, tool, await runDataChatTurn({
        catalog: turn.catalogFor(turnDb) ?? turn.catalogFor(db)!,
        scope: turn.scope,
        question,
        history: persist.history,
        ...directTurnOptions(dataChat, tool, toolArgs),
        complete: completion ? completion(organizationId, cfg.role) : NO_LLM_COMPLETION,
        ...(completion ? { completeRetry: completion(organizationId, `${cfg.vertical}:${DATA_CHAT_RETRY_SUFFIX}`) } : {}),
        ...auxiliaryTurnOptions(dataChat, organizationId),
        ...(persist.resumen ? { summary: persist.resumen } : {}),
        rateLimiter: dataChat.rateLimiter,
        audit: persist.audit(dataChat.audit(turnDb)),
        onEvento,
        signal,
        onUso: logUsoDataChat(c, cfg.vertical),
        auditRole: cfg.role,
        onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", vertical: cfg.vertical, where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
      })),
      persist.despuesDelCommit,
    );
  });

  mountConversacionesRoutes(app, deps, { base, vertical: cfg.vertical, roles: cfg.roles });
  mountPinsRoutes(app, deps, { base, vertical: cfg.vertical, roles: cfg.roles, turnContext });
  // Adjuntar archivo (CSV / Excel / PDF): analisis determinista en el servidor, sin guardar el archivo.
  mountAdjuntosRoutes(app, deps, { base, vertical: cfg.vertical, roles: cfg.roles, role: cfg.role });
  // CHAT-14: reporte PDF de un mensaje guardado, con el mismo alcance (membership, zona horaria, rol) que el chat.
  mountReporteRoutes(app, deps, {
    base,
    vertical: cfg.vertical,
    roles: cfg.roles,
    resolve: async (c, db) => {
      const catalog = cfg.catalog(deps, db);
      if (!catalog) return undefined;
      const organizationId = c.get("organizationId");
      const allowedPropertyIds = await resolveMembershipPropertyScope(deps, c, organizationId);
      const timezone = await cfg.timezone(deps, db, c.req.param("propertyId") ?? "", organizationId);
      return { catalog, scope: { organizationId, userId: c.get("userId"), vertical: cfg.vertical, verticalRole: c.get("verticalRole") ?? "", allowedPropertyIds, timezone } };
    },
  });
  return app;
}
