// Fase 7 -- GET de las políticas de canal de mensajería (H-057, H-058). Función pura
// de dominio (packages/domain-rentas/src/mensajeria/politica.ts) -- sin BD, sin
// escritura, documentación operativa de a qué se atiene `validarMensajeSaliente` al
// aprobar un borrador. Igual que cualquier otra ruta de staff autenticado del
// vertical (requirePropertyMembership), pero SIN `assertVerticalRole`: es información
// de solo lectura sobre reglas ya públicas de cada canal, abierta a cualquier rol de
// vertical con acceso a la property (mismo criterio que
// mensajeria-conversaciones.ts::GET).
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CANALES_MENSAJERIA, POLITICAS_POR_CANAL } from "@atiende/domain-rentas";
import type { AppDeps } from "../../../deps.ts";

export function rentasMensajeriaPoliticasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/rentas/:propertyId/mensajeria/politicas";
  app.use(base, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, (c) => c.json({ politicas: CANALES_MENSAJERIA.map((canal) => POLITICAS_POR_CANAL[canal]) }, 200));

  return app;
}
