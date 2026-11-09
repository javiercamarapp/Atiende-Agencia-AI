// Interruptor por ORGANIZACION del aviso «su pedido va en camino» por WhatsApp (migracion 107; docs/restaurantes/AVISO-EN-CAMINO.md).
//   GET /v1/restaurantes/:propertyId/admin/whatsapp/aviso-en-camino   lectura (roles de gestion) + la plantilla que hay que dar de alta en Meta
//   PUT /v1/restaurantes/:propertyId/admin/whatsapp/aviso-en-camino   { activo: boolean } (owner/admin de toda la organizacion; bitacora antes/despues)
// Encendido por omision. La base es la autoridad (funcion definer con 42501); esta capa es defensa en profundidad. Base SIN la 107: la lectura
// responde `disponible: false` (encendido: es lo que hace el aviso anterior) y la escritura 503 honesto. Sin pantalla nueva: lo usa soporte o un toggle futuro.
import { Hono } from "hono";
import { assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { AvisoEnCaminoConfigRechazadaError, EVENTO_PLANTILLA_EN_CAMINO, MANAGER_ROLES, PLANTILLA_EN_CAMINO_SUGERIDA, STAFF_INVITE_ROLES } from "@atiende/domain-restaurantes";
import type { LecturaConfigAvisoEnCamino } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { assertAdminGeneral } from "./admin-scope.ts";

const NO_DISPONIBLE = "El aviso «va en camino» todavía no se puede configurar en esta base de datos (falta aplicar la migración 107).";

function serializar(l: LecturaConfigAvisoEnCamino) {
  return {
    disponible: l.disponible,
    activo: l.activo,
    plantilla: {
      evento: EVENTO_PLANTILLA_EN_CAMINO,
      nombre: PLANTILLA_EN_CAMINO_SUGERIDA.nombre,
      idioma: PLANTILLA_EN_CAMINO_SUGERIDA.idioma,
      categoria: "utility",
      variables: [...PLANTILLA_EN_CAMINO_SUGERIDA.variables],
    },
  };
}

function leerActivo(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("Se esperaba un objeto { activo: boolean }.");
  const claves = Object.keys(raw);
  if (claves.length !== 1 || claves[0] !== "activo") throw Errors.validation("Solo se admite el campo activo.");
  const activo = (raw as { activo?: unknown }).activo;
  if (typeof activo !== "boolean") throw Errors.validation("activo debe ser true o false.");
  return activo;
}

export function restaurantesAvisoEnCaminoConfigRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/whatsapp/aviso-en-camino";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const lectura = repo.leerConfigAvisoEnCamino ? await repo.leerConfigAvisoEnCamino(c.get("organizationId")) : { disponible: false, activo: true };
    return c.json(serializar(lectura));
  });

  app.put(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    // Es una regla de toda la organizacion: un admin acotado a una sucursal no la cambia.
    await assertAdminGeneral(deps, c);
    const organizationId = c.get("organizationId");
    const actorUserId = c.get("userId");
    const activo = leerActivo(await readJsonCapped<unknown>(c.req.raw, 256));
    const repo = deps.restaurantesRepo(c.get("db"));
    if (!repo.leerConfigAvisoEnCamino || !repo.guardarConfigAvisoEnCamino) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const anterior = await repo.leerConfigAvisoEnCamino(organizationId);
    let guardado: LecturaConfigAvisoEnCamino;
    try {
      guardado = await repo.guardarConfigAvisoEnCamino(organizationId, activo);
    } catch (err) {
      if (err instanceof AvisoEnCaminoConfigRechazadaError) throw Errors.forbidden(err.message);
      throw err;
    }
    if (!guardado.disponible) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    logEvent(c, "info", "restaurantes_admin_aviso_en_camino_actualizado", { actorUserId, organizationId, activo: guardado.activo });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId,
      action: "configuracion.aviso_en_camino_actualizado",
      entityType: "configuracion",
      entityId: organizationId,
      campo: "aviso_en_camino",
      antes: anterior.activo ? "encendido" : "apagado",
      despues: guardado.activo ? "encendido" : "apagado",
    });
    return c.json(serializar(guardado));
  });

  return app;
}
