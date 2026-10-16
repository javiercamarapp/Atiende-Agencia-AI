// Umbrales configurables de las alertas al dueño (autopiloto 2, migracion 052): hoy, «WhatsApp silencioso».
//   GET .../admin/alertas-duenio          umbrales vigentes (los valores por omision conservadores si la organizacion no guardo los suyos)
//   PUT .../admin/alertas-duenio          { silencioActivo, silencioVentanaMin (15..360), silencioHistoricoMin (1..1000) }
// Solo owner/admin con alcance a TODA la organizacion (la base lo exige y deja bitacora). Sin la migracion: GET -> disponible:false con los valores por
// omision; PUT -> 503. Sin PII.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { AlertasDuenioNoDisponibleError, AlertasDuenioParametrosError, AlertasDuenioSinAccesoError, STAFF_INVITE_ROLES, guardarUmbralesAlertasDuenio, leerUmbralesAlertasDuenio } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

interface Body {
  readonly silencioActivo?: unknown;
  readonly silencioVentanaMin?: unknown;
  readonly silencioHistoricoMin?: unknown;
}

function traducir(err: unknown): never {
  if (err instanceof AlertasDuenioNoDisponibleError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof AlertasDuenioSinAccesoError) throw Errors.forbidden(err.message);
  if (err instanceof AlertasDuenioParametrosError) throw Errors.validation(err.message);
  throw err;
}

export function restaurantesAdminAlertasDuenioRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/alertas-duenio";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    try {
      const r = await leerUmbralesAlertasDuenio(c.get("db"), c.get("organizationId"));
      return c.json({ disponible: r.disponible, ...r.umbrales });
    } catch (err) {
      return traducir(err);
    }
  });

  app.put(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const raw = await readJsonCapped<Body>(c.req.raw, 2 * 1024);
    if (typeof raw.silencioActivo !== "boolean") throw Errors.validation("silencioActivo: se esperaba un booleano.");
    const ventana = raw.silencioVentanaMin;
    if (typeof ventana !== "number" || !Number.isInteger(ventana) || ventana < 15 || ventana > 360) throw Errors.validation("silencioVentanaMin: se esperaba un entero entre 15 y 360 minutos.");
    const historico = raw.silencioHistoricoMin;
    if (typeof historico !== "number" || !Number.isFinite(historico) || historico < 1 || historico > 1000) throw Errors.validation("silencioHistoricoMin: se esperaba un número entre 1 y 1000.");
    try {
      await guardarUmbralesAlertasDuenio(c.get("db"), organizationId, { silencioActivo: raw.silencioActivo, silencioVentanaMin: ventana, silencioHistoricoMin: historico });
    } catch (err) {
      return traducir(err);
    }
    logEvent(c, "info", "restaurantes_alertas_duenio_umbrales_guardados", { actorUserId: c.get("userId"), organizationId });
    const r = await leerUmbralesAlertasDuenio(c.get("db"), organizationId);
    return c.json({ disponible: r.disponible, ...r.umbrales });
  });

  return app;
}
