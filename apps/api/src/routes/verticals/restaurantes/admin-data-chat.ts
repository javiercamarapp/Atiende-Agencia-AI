// "Chatea con tus datos" -- vertical piloto RESTAURANTES. Misma cadena de autorizacion que los KPIs
// (`admin-kpis.ts`): JWT -> sesion RLS del usuario (`dbSession`) -> membership verificada
// (`requirePropertyMembership`) -> rol de gestion (MANAGER_ROLES, excluye repartidor).
//
// El alcance (organizacion, sucursales de la membership, zona horaria, rol) lo fija ESTE handler a
// partir de la sesion verificada; el cuerpo de la peticion solo aporta la pregunta y el historial
// (texto), jamas ids ni filtros. Las consultas corren con la sesion RLS del usuario, nunca con una
// sesion de sistema. Toda la logica de negocio vive en @atiende/agent-core/data-chat (motor) y
// @atiende/domain-restaurantes (catalogo): aqui solo se valida entrada y se serializa la respuesta.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { DEFAULT_DATA_CHAT_TIMEZONE, runDataChatTurn } from "@atiende/agent-core/data-chat";
import { MANAGER_ROLES, buildRestaurantesDataChatCatalog } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { parseDataChatBody } from "../../../data-chat/body.ts";
import { DATA_CHAT_RETRY_SUFFIX } from "../../../production/llm-models.ts";

export function restaurantesAdminDataChatRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/restaurantes/:propertyId/admin/chat-datos";
  for (const path of [base, `${base}/*`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // La UI lo consulta para mostrar "Pronto" mientras no haya proveedor de IA configurado.
  app.get(`${base}/estado`, (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    return c.json({ available: Boolean(deps.dataChat?.completion) });
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const raw: unknown = await c.req.json().catch(() => {
      throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
    });
    const { question, history, tool } = parseDataChatBody(raw);

    const dataChat = deps.dataChat;
    const organizationId = c.get("organizationId");
    const completion = dataChat?.completion;
    if (!dataChat || !completion) {
      return c.json({ status: "unavailable", text: "El asistente de datos todavía no está activado para tu cuenta. Tus tableros siguen disponibles.", blocks: [], sources: [], toolsUsed: [] });
    }

    const db = c.get("db");
    const allowedPropertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const zona = await deps.restaurantesRepo(db).findBranchZonaHoraria(c.req.param("propertyId") ?? "");

    const answer = await runDataChatTurn({
      catalog: buildRestaurantesDataChatCatalog(dataChat.restaurantesReader(db)),
      scope: {
        organizationId,
        userId: c.get("userId"),
        vertical: "restaurantes",
        verticalRole: c.get("verticalRole") ?? "",
        allowedPropertyIds,
        timezone: zona.zonaHoraria ?? DEFAULT_DATA_CHAT_TIMEZONE,
      },
      question,
      history,
      ...(tool ? { directTool: tool } : {}),
      complete: completion(organizationId),
      completeRetry: completion(organizationId, `restaurantes:${DATA_CHAT_RETRY_SUFFIX}`),
      rateLimiter: dataChat.rateLimiter,
      audit: dataChat.audit(db),
      onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
    });
    return c.json(answer);
  });

  return app;
}
