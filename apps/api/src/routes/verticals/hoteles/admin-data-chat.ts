// "Chatea con tus datos" de HOTELES: POST/GET /hoteles/:propertyId/chat-datos[/estado]. Solo owner y gm (ADMIN_ROLES):
// el catalogo lee dinero (cargos del folio: RLS can_access_money) y tickets de TODOS los departamentos
// (guest_ticket_visible), y un rol operativo vería una vista parcial que parecería completa. Ver
// ../../../data-chat/vertical-routes.ts y docs/DATA-CHAT.md.
import type { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { ADMIN_ROLES, buildHotelesDataChatCatalog } from "@atiende/domain-hoteles";
import type { AppDeps } from "../../../deps.ts";
import { verticalDataChatRoutes } from "../../../data-chat/vertical-routes.ts";

export function hotelesAdminDataChatRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  return verticalDataChatRoutes(deps, {
    vertical: "hoteles",
    roles: ADMIN_ROLES,
    catalog: (d, db) => (d.dataChat?.hotelesReader ? buildHotelesDataChatCatalog(d.dataChat.hotelesReader(db)) : undefined),
    completion: (d) => d.dataChat?.hotelesCompletion,
    timezone: async (d, db, propertyId) => resolverZonaHorariaNegocio(await d.hotelesRepo(db).findPropertyTimezone(propertyId)),
  });
}
