// Interruptor de emergencia UNIFICADO (migracion 103): un solo control que apaga el agente de WhatsApp Y el de voz de una sucursal o de toda la organizacion
// y deja pasar todo a una persona. Solo owner/admin (STAFF_INVITE_ROLES); la autoridad real es la funcion `restaurantes.interruptor_fijar` (el interruptor de
// toda la organizacion exige un owner/admin SIN acotar a sucursales). Todo cambio deja historial en la base y bitacora de auditoria, y avisa en la campana
// al equipo cuando se APAGA. Base sin migrar: GET `disponible: false`, PUT 503 honesto (nunca 500).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { emitirNotificacion } from "@atiende/db";
import { InterruptorNoDisponibleError, STAFF_INVITE_ROLES, pgFijarInterruptor, pgListarInterruptores } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

export function restaurantesAdminInterruptorRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/interruptor-emergencia";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const lista = await pgListarInterruptores(c.get("db"), organizationId);
    return c.json({
      disponible: lista.disponible,
      organizacionApagada: lista.filas.some((f) => f.propertyId === null),
      sucursalApagada: lista.filas.some((f) => f.propertyId === c.req.param("propertyId")),
      apagados: lista.filas,
    });
  });

  app.put(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    const raw = await readJsonCapped<{ alcance?: unknown; apagado?: unknown; motivo?: unknown }>(c.req.raw, 2048);
    if (raw.alcance !== "sucursal" && raw.alcance !== "organizacion") throw Errors.validation('alcance: debe ser "sucursal" o "organizacion".');
    if (typeof raw.apagado !== "boolean") throw Errors.validation("apagado: se esperaba true o false.");
    if (raw.motivo !== undefined && raw.motivo !== null && (typeof raw.motivo !== "string" || raw.motivo.length > 300)) throw Errors.validation("motivo: texto de hasta 300 caracteres.");
    const motivo = typeof raw.motivo === "string" && raw.motivo.trim() !== "" ? raw.motivo.trim() : null;
    const destino = raw.alcance === "organizacion" ? null : propertyId;
    let previo: boolean;
    try {
      previo = await pgFijarInterruptor(c.get("db"), { organizationId, propertyId: destino, apagado: raw.apagado, motivo });
    } catch (err) {
      if (err instanceof InterruptorNoDisponibleError) throw Errors.serviceUnavailable(err.message);
      if ((err as { code?: string } | null)?.code === "42501") throw Errors.forbidden("No tienes acceso para cambiar este interruptor.");
      throw err;
    }
    logEvent(c, "info", "restaurantes_admin_interruptor_emergencia", { actorUserId: c.get("userId"), organizationId, propertyId: destino, apagado: raw.apagado });
    const repo = deps.restaurantesRepo(c.get("db"));
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: "configuracion.interruptor_emergencia",
      entityType: "configuracion",
      entityId: destino ?? organizationId,
      campo: "interruptorEmergencia",
      antes: String(previo),
      despues: String(raw.apagado),
    });
    if (raw.apagado && !previo) {
      await emitirNotificacion(c.get("db"), {
        evento: "restaurantes.interruptor.activado",
        organizationId,
        ...(destino ? { propertyId: destino } : {}),
        clave: `${destino ?? organizationId}:${new Date().toISOString().slice(0, 13)}`,
        entidadTipo: "interruptor_emergencia",
        entidadId: destino ?? organizationId,
      });
    }
    return c.json({ disponible: true, alcance: raw.alcance, apagado: raw.apagado, cambio: previo !== raw.apagado });
  });

  return app;
}
