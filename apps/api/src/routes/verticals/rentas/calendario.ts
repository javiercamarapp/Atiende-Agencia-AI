// Fase 13 -- calendario visual del panel de staff: cierra el hallazgo de auditoría
// "Calendario de reservas y bloqueos: backend completo sin UI" -- reservas.ts (Fase 1)
// y bloqueos.ts (Fase 4) ya exponían crear/modificar/cancelar reservas y crear/listar/
// liberar bloqueos, pero NO existía ningún GET que devolviera, para una unidad, TODAS
// sus ocupaciones (reserva de canal Y bloqueo) en una sola vista -- el listado mínimo
// indispensable para poder pintar un calendario real. Esta ruta agrega exactamente
// ese listado que faltaba (`listOcupaciones`, Fase 13 de @atiende/domain-rentas) más
// el descubrimiento de unidades de una property (`listUnidades`) que el selector de
// unidad del calendario necesita y que hasta ahora tampoco existía por HTTP.
//
// Mismo patrón arquitectónico que reservas.ts/bloqueos.ts: sesión de staff obligatoria
// (authMiddleware + dbSession + requirePropertyMembership), filtrado fino de rol con
// assertVerticalRole dentro de cada handler -- pero con `CALENDARIO_LECTURA_ROLES`
// (Fase 13) en vez de `ESCRITURA_CALENDARIO_ROLES`: estas dos rutas son de SOLO
// LECTURA, así que también se abren a `operador:solo_calendario` (el rol de "puede
// ver el calendario, no puede tocarlo" que ya existía en RENTAS_VERTICAL_ROLES desde
// la Fase 1 sin que ninguna ruta de calendario lo aceptara todavía -- ver el
// comentario de cabecera de esa constante en roles.ts). Deliberadamente NO se toca el
// rol de `GET .../bloqueos` (bloqueos.ts): esa ruta ya existía antes de esta fase con
// `ESCRITURA_CALENDARIO_ROLES` y ampliarla es un cambio de comportamiento fuera del
// alcance de este hallazgo.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CALENDARIO_LECTURA_ROLES } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export function rentasCalendarioRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const unidadesPath = "/rentas/:propertyId/unidades";
  const ocupacionesPath = "/rentas/:propertyId/unidades/:unidadId/ocupaciones";
  app.use(unidadesPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(ocupacionesPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(unidadesPath, async (c) => {
    assertVerticalRole(c, CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const repo = deps.rentasRepo(c.get("db"));

    const unidades = await repo.listUnidades(propertyId);
    return c.json({ unidades: unidades.map((u) => ({ id: u.id, nombre: u.name ?? u.id, duracionMinimaNoches: u.duracionMinimaNoches })) }, 200);
  });

  app.get(ocupacionesPath, async (c) => {
    assertVerticalRole(c, CALENDARIO_LECTURA_ROLES);
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const repo = deps.rentasRepo(c.get("db"));

    // Defensa en profundidad, mismo criterio que reservas.ts/bloqueos.ts: nunca
    // confiar en que el cliente "sabe" que `unidadId` pertenece a `propertyId`.
    const unidad = await repo.findUnidad(propertyId, unidadId);
    if (!unidad) throw Errors.notFound("Unidad no encontrada en esta property.");

    const ocupaciones = await repo.listOcupaciones(propertyId, unidadId);
    return c.json({ ocupaciones }, 200);
  });

  return app;
}
