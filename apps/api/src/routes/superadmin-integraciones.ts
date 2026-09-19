// Back office de plataforma — estado de integraciones externas, consultable en
// vivo. Archivo NUEVO a propósito (nunca se agregó a routes/superadmin.ts): otra
// sesión trabaja en paralelo sobre superadmin.ts/SuperAdminShell.tsx/App.tsx (la
// pantalla de gasto de API) — este endpoint se monta aparte en app.ts, mismo
// patrón que notifications.ts/billing.ts (infraestructura de plataforma, no de un
// solo vertical).
//
// Misma autorización EXACTA que routes/superadmin.ts (`authMiddleware` +
// `deps.coreRepo.isPlatformSuperadmin`) — nunca inventes un chequeo nuevo para una
// ruta que vive en el mismo back office.
//
// Este endpoint JAMÁS expone un valor, prefijo o longitud de secreto — solo
// nombres de variable (`faltantes`) y booleanos (`configurada`). Toda la lógica
// real vive en `../integrations-status.ts` (función pura, sin acceso a
// `process.env`); esta ruta es el único punto de este archivo que lee `process.env`
// (una vez, para armar el snapshot que le pasa a esa función pura).
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../errors.ts";
import { computeIntegrationsStatus } from "../integrations-status.ts";
import type { AppDeps } from "../deps.ts";

export function superadminIntegracionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/integraciones", authMiddleware(deps.env));
  app.use("/superadmin/integraciones", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) {
      throw Errors.forbidden("Este panel es exclusivo del back office de plataforma.");
    }
    await next();
  });

  app.get("/superadmin/integraciones", (c) => {
    const integraciones = computeIntegrationsStatus(process.env);
    return c.json({ integraciones });
  });

  return app;
}
