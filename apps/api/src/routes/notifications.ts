// Infraestructura de notificaciones REAL, genérica para las 6 verticales +
// superadmin (ver el comentario de cabecera de
// `supabase/migrations/20240101000115_0013_notifications_schema.sql` para el
// esquema/las 4 funciones `security definer` que respaldan esto). Vive en
// `apps/api/src/routes/` (no dentro de un `routes/verticals/<x>/`) por el mismo
// motivo que `routes/auth.ts`/`routes/superadmin.ts`: no es de ningún dominio
// concreto, es núcleo compartido — cualquier vertical (o el propio back office de
// plataforma) puede haber generado una fila para este staff sin que esta ruta
// necesite saber cuál.
//
// Autorización real: `deps.coreRepo.markNotificationRead`/`listNotificationsForStaff`/
// etc. YA reciben `c.get("userId")` (la sesión JWT ya verificada por
// `authMiddleware`, nunca un id del body/query) y las funciones SQL que consumen
// solo pueden leer/escribir la fila de ESE `p_staff_id` — el chequeo de aquí es
// defensa en profundidad (401 explícito sin token), nunca la única autoridad real.
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { NotificationNotFoundError } from "@atiende/db";
import type { ListNotificationsOptions, NotificationRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";

function serializeNotification(n: NotificationRow) {
  return {
    id: n.id,
    vertical: n.vertical,
    titulo: n.titulo,
    cuerpo: n.cuerpo,
    entidadTipo: n.entidadTipo,
    entidadId: n.entidadId,
    createdAt: n.createdAt,
    readAt: n.readAt,
    organizationId: n.organizationId,
    tipo: n.tipo,
    categoria: n.categoria,
    severidad: n.severidad,
    enlace: n.enlace,
  };
}

const CATEGORIA_QUERY_RE = /^[a-z][a-z_]{1,39}$/;

/** Filtros opcionales de `GET /notifications` (`limit` 1..100, `before` ISO 8601, `unread=1`, `categoria`).
 *  Un valor invalido es 400: nunca se ignora en silencio un filtro que cambiaria lo que se muestra. */
function parseListOptions(query: Record<string, string>): ListNotificationsOptions {
  const out: { limit?: number; before?: string; soloNoLeidas?: boolean; categoria?: string } = {};
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw Errors.validation("limit debe ser un entero entre 1 y 100");
    out.limit = n;
  }
  if (query.before !== undefined) {
    const t = Date.parse(query.before);
    if (Number.isNaN(t)) throw Errors.validation("before debe ser una fecha ISO 8601");
    out.before = new Date(t).toISOString();
  }
  if (query.unread !== undefined) {
    if (query.unread !== "1" && query.unread !== "0") throw Errors.validation("unread debe ser 1 o 0");
    out.soloNoLeidas = query.unread === "1";
  }
  if (query.categoria !== undefined) {
    if (!CATEGORIA_QUERY_RE.test(query.categoria)) throw Errors.validation("categoria invalida");
    out.categoria = query.categoria;
  }
  return out;
}

export function notificationsRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/notifications/*", authMiddleware(deps.env));

  // Lista + conteo de no leídas en una sola llamada -- mismo criterio que el
  // dropdown de la campana de la referencia (atiende-restaurantes): un solo
  // request le basta al frontend para pintar el badge y el contenido del
  // dropdown, sin una segunda query aparte para el número.
  app.get("/notifications", async (c) => {
    const staffId = c.get("userId");
    const options = parseListOptions(c.req.query());
    const [notifications, unreadCount] = await Promise.all([
      deps.coreRepo.listNotificationsForStaff(staffId, options),
      deps.coreRepo.countUnreadNotificationsForStaff(staffId),
    ]);
    return c.json({ notifications: notifications.map(serializeNotification), unreadCount });
  });

  app.post("/notifications/:id/read", async (c) => {
    const staffId = c.get("userId");
    const notificationId = c.req.param("id");
    try {
      await deps.coreRepo.markNotificationRead(staffId, notificationId);
    } catch (err) {
      if (err instanceof NotificationNotFoundError) throw Errors.notFound(err.message);
      throw err;
    }
    const unreadCount = await deps.coreRepo.countUnreadNotificationsForStaff(staffId);
    return c.json({ ok: true, unreadCount });
  });

  app.post("/notifications/read-all", async (c) => {
    const staffId = c.get("userId");
    const markedCount = await deps.coreRepo.markAllNotificationsRead(staffId);
    return c.json({ ok: true, markedCount, unreadCount: 0 });
  });

  return app;
}
