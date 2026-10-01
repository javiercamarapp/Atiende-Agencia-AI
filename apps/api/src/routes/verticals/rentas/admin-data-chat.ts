// "Chatea con tus datos" de RENTAS: POST/GET /rentas/:propertyId/chat-datos[/estado]. Solo admin_gestora y contador
// (FINANZAS_LECTURA_ROLES): el catalogo lee finanzas (reserva_financiero, liquidaciones, pagos: RLS can_read_finanzas) y
// un operador veria las cifras de dinero vacias, que parecerian ceros. Ver ../../../data-chat/vertical-routes.ts y
// docs/DATA-CHAT.md.
import type { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { FINANZAS_LECTURA_ROLES, buildRentasDataChatCatalog } from "@atiende/domain-rentas";
import type { AppDeps } from "../../../deps.ts";
import { RENTAS_DATA_CHAT_ROLE } from "../../../production/llm-gateway.ts";
import { verticalDataChatRoutes } from "../../../data-chat/vertical-routes.ts";

export function rentasAdminDataChatRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  return verticalDataChatRoutes(deps, {
    vertical: "rentas",
    roles: FINANZAS_LECTURA_ROLES,
    catalog: (d, db) => (d.dataChat?.rentasReader ? buildRentasDataChatCatalog(d.dataChat.rentasReader(db)) : undefined),
    role: RENTAS_DATA_CHAT_ROLE,
    timezone: async (d, db, propertyId) => resolverZonaHorariaNegocio(await d.rentasCalendarSyncRepo(db).findZonaHorariaPropiedad(propertyId)),
  });
}
