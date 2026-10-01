// Rutas de "Chatea con tus datos" para las verticales POR PROPIEDAD (hoteles, rentas): misma cadena de
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
import { runDataChatTurn, type DataChatCatalog, type DataChatCompletion, type DataChatHistoryTurn } from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";

const MAX_BODY_HISTORY = 12;

export function parseDataChatBody(raw: unknown): { question: string; history: DataChatHistoryTurn[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Cuerpo inválido: se esperaba un objeto JSON.");
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "question" && key !== "history") throw Errors.validation(`Campo no permitido: ${key.slice(0, 40)}.`);
  }
  if (typeof body["question"] !== "string") throw Errors.validation("question: se esperaba texto.");
  const history: DataChatHistoryTurn[] = [];
  const rawHistory = body["history"];
  if (rawHistory !== undefined) {
    if (!Array.isArray(rawHistory) || rawHistory.length > MAX_BODY_HISTORY) throw Errors.validation(`history: se esperaba una lista de a lo mucho ${MAX_BODY_HISTORY} turnos.`);
    for (const item of rawHistory) {
      const t = item as { role?: unknown; text?: unknown };
      if ((t?.role !== "user" && t?.role !== "assistant") || typeof t.text !== "string") throw Errors.validation("history: cada turno debe ser {role: 'user'|'assistant', text}.");
      history.push({ role: t.role, text: t.text });
    }
  }
  return { question: body["question"], history };
}

export interface VerticalDataChatConfig {
  /** "hoteles" | "rentas": prefijo de ruta (`/hoteles/:propertyId/chat-datos`) y etiqueta del alcance. */
  readonly vertical: "hoteles" | "rentas";
  /** Roles de la vertical que pueden usar el chat (la RLS sigue siendo la autoridad final). */
  readonly roles: readonly string[];
  /** Catalogo ya ligado al lector de la sesion RLS del usuario; undefined = esta vertical no esta cableada. */
  readonly catalog: (deps: AppDeps, db: TenantDbSession) => DataChatCatalog | undefined;
  /** Proveedor de IA de esta vertical (rol de gateway propio); undefined = sin proveedor configurado. */
  readonly completion: (deps: AppDeps) => ((organizationId: string) => DataChatCompletion) | undefined;
  /** Zona horaria IANA ya resuelta de la propiedad activa. */
  readonly timezone: (deps: AppDeps, db: TenantDbSession, propertyId: string) => Promise<string>;
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
    return c.json({ available: Boolean(cfg.completion(deps) && cfg.catalog(deps, c.get("db"))) });
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, cfg.roles);
    const raw: unknown = await c.req.json().catch(() => {
      throw Errors.validation("Cuerpo inválido: se esperaba JSON.");
    });
    const { question, history } = parseDataChatBody(raw);

    const dataChat = deps.dataChat;
    const organizationId = c.get("organizationId");
    const db = c.get("db");
    const completion = cfg.completion(deps);
    const catalog = cfg.catalog(deps, db);
    if (!dataChat || !completion || !catalog) {
      return c.json({ status: "unavailable", text: "El asistente de datos todavía no está activado para tu cuenta. Tus tableros siguen disponibles.", blocks: [], sources: [], toolsUsed: [] });
    }

    // Alcance por membership: nunca se ensancha mas alla de las propiedades de este usuario (mismo criterio que
    // restaurantes/admin-scope.ts). Si la membership completa no aparece, cae a la unica propiedad ya verificada.
    const propertyId = c.req.param("propertyId") ?? "";
    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    const membership = memberships.find((m) => m.organizationId === organizationId);
    const allowedPropertyIds: readonly string[] | null = membership ? membership.propertyIds : [propertyId];
    const timezone = await cfg.timezone(deps, db, propertyId);

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
      complete: completion(organizationId),
      rateLimiter: dataChat.rateLimiter,
      audit: dataChat.audit(db),
      onError: (where, err) => console.error(JSON.stringify({ level: "error", event: "data_chat_error", vertical: cfg.vertical, where, message: err instanceof Error ? err.message.slice(0, 200) : "error" })),
    });
    return c.json(answer);
  });

  return app;
}
