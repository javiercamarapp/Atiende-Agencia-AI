// Rutas de "Chatea con tus datos" para las verticales POR PROPIEDAD (hoteles, rentas, citas): misma cadena de
// autorizacion que la ruta de restaurantes -- JWT -> sesion RLS del usuario (`dbSession`) -> membership verificada
// (`requirePropertyMembership`) -> rol permitido de la vertical -- y el MISMO motor (`runDataChatTurn`).
//
// El alcance (organizacion, propiedades de la membership, zona horaria, rol) lo fija ESTE codigo a partir de la
// sesion verificada; el cuerpo de la peticion solo aporta la pregunta y el historial (texto), jamas ids ni
// filtros. Las consultas corren con la sesion RLS del usuario, nunca con una de sistema. La logica de negocio
// vive en @atiende/agent-core/data-chat (motor) y en el catalogo del dominio (domain-hoteles / domain-rentas).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { runDataChatTurn, type DataChatCatalog } from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";
import { DATA_CHAT_RETRY_SUFFIX } from "../production/llm-models.ts";
import { parseDataChatBody } from "./body.ts";
import { resolveMembershipPropertyScope } from "./property-scope.ts";

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
  app.get(`${base}/estado`, (c) => {
    assertVerticalRole(c, cfg.roles);
    return c.json({ available: Boolean(deps.dataChat?.completion && cfg.catalog(deps, c.get("db"))) });
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const raw: unknown = await c.req.json().catch(() => {
      throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
    });
    const { question, history, tool } = parseDataChatBody(raw);

    const dataChat = deps.dataChat;
    const organizationId = c.get("organizationId");
    const db = c.get("db");
    const completion = dataChat?.completion;
    const catalog = cfg.catalog(deps, db);
    if (!dataChat || !completion || !catalog) {
      return c.json({ status: "unavailable", text: "El asistente de datos todavía no está activado para tu cuenta. Tus tableros siguen disponibles.", blocks: [], sources: [], toolsUsed: [] });
    }

    // Alcance por membership: nunca se ensancha mas alla de las propiedades de este usuario (mismo criterio que
    // restaurantes/admin-scope.ts). Si la membership completa no aparece, cae a la unica propiedad ya verificada.
    const allowedPropertyIds = await resolveMembershipPropertyScope(deps, c, organizationId);
    const propertyId = c.req.param("propertyId") ?? "";
    const timezone = await cfg.timezone(deps, db, propertyId, organizationId);

    const answer = await runDataChatTurn({
      catalog,
      scope: {
        organizationId,
        userId: c.get("userId"),
        vertical: cfg.vertical,
        verticalRole: c.get("verticalRole") ?? "",
        allowedPropertyIds,
        timezone,
      },
      question,
      history,
      ...(tool ? { directTool: tool } : {}),
      complete: completion(organizationId, cfg.role),
      completeRetry: completion(organizationId, `${cfg.vertical}:${DATA_CHAT_RETRY_SUFFIX}`),
      rateLimiter: dataChat.rateLimiter,
      audit: dataChat.audit(db),
      onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", vertical: cfg.vertical, where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
    });
    return c.json(answer);
  });

  return app;
}
