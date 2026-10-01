// "Chatea con tus datos" de CITAS (C-10): POST/GET /citas/:propertyId/chat-datos[/estado]. Solo owner y admin
// (DATA_CHAT_ROLES): el catalogo lee ingresos, tasas de cancelacion por profesional y el estado de envio de los
// recordatorios, informacion de gestion que el rol `staff` no tiene en el panel (la RLS de las citas no distingue rol, asi
// que este candado de rol es el que cuenta). La sucursal activa fija la zona horaria (`citas.property_config`, si no hay la de
// la organizacion). Cadena de autorizacion, alcance, limites y bitacora: ../../../data-chat/vertical-routes.ts y
// docs/DATA-CHAT.md.
import type { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { DATA_CHAT_ROLES, buildCitasDataChatCatalog } from "@atiende/domain-citas";
import type { AppDeps } from "../../../deps.ts";
import { CITAS_DATA_CHAT_ROLE } from "../../../production/llm-gateway.ts";
import { verticalDataChatRoutes } from "../../../data-chat/vertical-routes.ts";

export function citasAdminDataChatRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  return verticalDataChatRoutes(deps, {
    vertical: "citas",
    roles: DATA_CHAT_ROLES,
    catalog: (d, db) => (d.dataChat?.citasReader ? buildCitasDataChatCatalog(d.dataChat.citasReader(db)) : undefined),
    role: CITAS_DATA_CHAT_ROLE,
    timezone: async (d, db, propertyId, organizationId) => resolverZonaHorariaNegocio(await d.citasRepo(db).findPropertyTimezone(propertyId, organizationId)),
  });
}
