// FASE 3 (producto) — hallazgo real: hoy NO existe ninguna ruta que permita al
// staff de restaurantes EDITAR desde el panel la configuración de WhatsApp
// (número/canal conectado) ni las zonas conocidas usadas para emparejar la
// sucursal más cercana -- son datos que hoy solo se cargan por seed/migración.
// Investigado antes de escribir cualquier código (ver el comentario de cabecera
// de `packages/domain-restaurantes/migrations/
// 021_restaurantes_config_editable_y_search_path_fix.sql` para el detalle
// completo): ambas tablas (`whatsapp_channel_config`/`known_zone`) YA EXISTEN
// desde Fase 1/2 -- este archivo CONECTA lo ya construido con una ruta y
// pantalla de edición, nunca rediseña el modelo de datos.
//
// Huecos conocidos, deliberadamente fuera de este archivo (ver knownGaps del
// PR): configuración de voz (ninguna tabla de voz existe para restaurantes,
// a diferencia de hoteles/citas) y horarios de atención (ninguna tabla de
// horarios existe en el schema base de restaurantes) -- ambos requieren una
// migración de esquema NUEVO más una decisión de producto (¿por organización o
// por sucursal? ¿excepciones?) que esta fase no debe inventar sin dirección
// explícita.
//
// Autorización: owner/admin únicamente (`STAFF_INVITE_ROLES`) -- mandato
// explícito de esta fase ("una ruta y pantalla de edición para owner/admin"),
// deliberadamente MÁS angosto que `MANAGER_ROLES` (que sí incluye "staff",
// usado por el catálogo del día a día en admin-catalog.ts) tanto para LEER
// como para EDITAR esta configuración -- mismo umbral que
// `admin-staff.ts`/`auditoria.ts` (config/staff/auditoría son más sensibles y
// menos frecuentes que precios/disponibilidad). Clasificación de sesión: TODAS
// las rutas de este archivo corren en la sesión de STAFF autenticado
// (`dbSession(deps.engine)` -> `withAppSession({userId: <el staff real>})`) --
// nunca sesión de sistema, no hay ningún caller de sistema real para esta
// configuración hoy.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { STAFF_INVITE_ROLES, RestaurantesConfigUnavailableError } from "@atiende/domain-restaurantes";
import type { KnownZone } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

interface UpsertWhatsappConfigBody {
  readonly phoneNumberId?: unknown;
}

interface CreateKnownZoneBody {
  readonly name?: unknown;
  readonly lat?: unknown;
  readonly lng?: unknown;
}

// `phone_number_id` real de Meta Cloud API es un identificador numérico de la
// plataforma (no el número telefónico en sí) -- dígitos, longitud generosa
// (Meta usa IDs de hasta ~20 dígitos hoy, este tope deja margen sin abrir la
// puerta a un payload arbitrariamente largo).
const PHONE_NUMBER_ID_RE = /^\d{5,32}$/;

function serializeKnownZone(zone: KnownZone) {
  return { id: zone.id, name: zone.name, lat: zone.lat, lng: zone.lng, createdAt: zone.createdAt };
}

export function restaurantesAdminConfigRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const whatsappPath = "/v1/restaurantes/:propertyId/admin/config/whatsapp";
  const zonasPath = "/v1/restaurantes/:propertyId/admin/config/zonas";
  const zonaItemPath = "/v1/restaurantes/:propertyId/admin/config/zonas/:zoneId";

  app.use(whatsappPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(zonasPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(zonaItemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(whatsappPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const config = await deps.restaurantesRepo(c.get("db")).getWhatsappChannelConfig(organizationId);
    return c.json(config);
  });

  app.put(whatsappPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");

    const raw = await readJsonCapped<UpsertWhatsappConfigBody>(c.req.raw, 1 * 1024);
    if (typeof raw.phoneNumberId !== "string" || !PHONE_NUMBER_ID_RE.test(raw.phoneNumberId)) {
      throw Errors.validation("phoneNumberId inválido -- se esperaban solo dígitos (5 a 32).");
    }

    const anterior = await deps.restaurantesRepo(c.get("db")).getWhatsappChannelConfig(organizationId);

    let actualizado;
    try {
      actualizado = await deps.restaurantesRepo(c.get("db")).upsertWhatsappChannelConfig(organizationId, raw.phoneNumberId);
    } catch (err) {
      if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }

    logEvent(c, "info", "restaurantes_admin_config_whatsapp_actualizado", { actorUserId: staffId, organizationId });

    // FASE 3 (producto) — "configuración ... de WhatsApp" (entityType
    // 'configuracion', reservado desde migrations/019 sin caller hasta ahora).
    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: staffId,
      action: "configuracion.whatsapp_actualizada",
      entityType: "configuracion",
      entityId: null,
      campo: "phoneNumberId",
      antes: anterior.phoneNumberId,
      despues: actualizado.phoneNumberId,
    });

    return c.json(actualizado);
  });

  app.get(zonasPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const zonas = await deps.restaurantesRepo(c.get("db")).listKnownZones(organizationId);
    return c.json({ zonas: zonas.map(serializeKnownZone) });
  });

  app.post(zonasPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");

    const raw = await readJsonCapped<CreateKnownZoneBody>(c.req.raw, 1 * 1024);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name.length < 1 || name.length > 120) throw Errors.validation("name: se esperaba texto no vacío (máx. 120 caracteres).");
    if (typeof raw.lat !== "number" || !Number.isFinite(raw.lat) || raw.lat < -90 || raw.lat > 90) {
      throw Errors.validation("lat: se esperaba un número entre -90 y 90.");
    }
    if (typeof raw.lng !== "number" || !Number.isFinite(raw.lng) || raw.lng < -180 || raw.lng > 180) {
      throw Errors.validation("lng: se esperaba un número entre -180 y 180.");
    }

    let creada;
    try {
      creada = await deps.restaurantesRepo(c.get("db")).createKnownZone(organizationId, { name, lat: raw.lat, lng: raw.lng });
    } catch (err) {
      if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }

    logEvent(c, "info", "restaurantes_admin_config_zona_creada", { actorUserId: staffId, organizationId, zoneId: creada.id });

    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: staffId,
      action: "configuracion.zona_creada",
      entityType: "configuracion",
      entityId: creada.id,
      campo: "name",
      antes: null,
      despues: creada.name,
    });

    return c.json(serializeKnownZone(creada), 201);
  });

  app.delete(zonaItemPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");
    const zoneId = c.req.param("zoneId");

    let eliminada: boolean;
    try {
      eliminada = await deps.restaurantesRepo(c.get("db")).deleteKnownZone(organizationId, zoneId);
    } catch (err) {
      if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }
    if (!eliminada) throw Errors.notFound("Esa zona conocida no existe, o pertenece a otra organización.");

    logEvent(c, "info", "restaurantes_admin_config_zona_eliminada", { actorUserId: staffId, organizationId, zoneId });

    await deps.restaurantesRepo(c.get("db")).registrarAuditoria({
      organizationId,
      actorUserId: staffId,
      action: "configuracion.zona_eliminada",
      entityType: "configuracion",
      entityId: zoneId,
      campo: null,
      antes: null,
      despues: null,
    });

    return c.json({ ok: true });
  });

  return app;
}
