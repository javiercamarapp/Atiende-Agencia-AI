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
import type { NotificationRow } from "@atiende/db";
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
  };
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
    const [notifications, unreadCount] = await Promise.all([
      deps.coreRepo.listNotificationsForStaff(staffId),
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
