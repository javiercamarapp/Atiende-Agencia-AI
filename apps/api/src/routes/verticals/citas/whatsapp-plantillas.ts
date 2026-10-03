// PL-31 -- /v1/citas/properties/:propertyId/admin/whatsapp-plantillas: catalogo de plantillas HSM de WhatsApp de la organizacion. Fuera de la
// ventana de 24 h de Meta un aviso del negocio solo se entrega como plantilla aprobada; aqui el owner/admin registra, por evento, el nombre
// que aprobo en Meta Business Manager (paso externo), el idioma, el orden de las variables y su estado. Un aviso sin plantilla aprobada
// NO se manda por WhatsApp (se avisa por correo cuando el cliente dejo uno).
//
// Autorizacion: owner/admin unicamente (`STAFF_INVITE_ROLES`), en la sesion de STAFF autenticado; la escritura real la vuelve a exigir la RLS
// de core.whatsapp_plantilla (owner/admin de la organizacion). Base sin la migracion 0048: GET responde 200 con `disponible: false` y las
// escrituras 503; nada cambia en los envios.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { EVENTOS_PLANTILLA_CITAS, PLANTILLA_ESTADOS, STAFF_INVITE_ROLES, eventoPlantillaCitas, validarPlantillaWhatsapp } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasWhatsappPlantillasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/v1/citas/properties/:propertyId/admin/whatsapp-plantillas";
  const porEvento = `${base}/:evento`;
  for (const path of [base, porEvento]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function eventoOrThrow(valor: string | undefined) {
    const evento = valor ? eventoPlantillaCitas(valor) : undefined;
    if (!evento) throw Errors.notFound("Ese evento no tiene plantilla de WhatsApp.");
    return evento;
  }

  // Lista las plantillas guardadas junto al catalogo de eventos (variables permitidas) para pintar la pantalla completa.
  app.get(base, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { disponible, items } = await deps.citasRepo(c.get("db")).listWhatsappTemplates(c.get("organizationId"));
    return c.json({
      disponible,
      estados: PLANTILLA_ESTADOS,
      eventos: EVENTOS_PLANTILLA_CITAS.map((e) => ({ evento: e.evento, etiqueta: e.etiqueta, variables: e.variables, plantilla: items.find((i) => i.evento === e.evento) ?? null })),
    });
  });

  app.put(porEvento, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const evento = eventoOrThrow(c.req.param("evento"));
    const validada = validarPlantillaWhatsapp(await readJsonCapped<unknown>(c.req.raw, 4 * 1024), evento);
    if (!validada.ok) throw Errors.validation(validada.error);
    const organizationId = c.get("organizationId");
    const repo = deps.citasRepo(c.get("db"));
    const resultado = await repo.saveWhatsappTemplate(organizationId, evento.evento, validada.valor);
    if (resultado === "forbidden") throw Errors.forbidden();
    if (resultado === "unavailable") throw Errors.serviceUnavailable("Las plantillas de WhatsApp todavía no están disponibles en este ambiente (migración pendiente).");
    logEvent(c, "info", "citas_admin_whatsapp_plantilla_guardada", { actorUserId: c.get("userId"), organizationId, eventoPlantilla: evento.evento, estado: validada.valor.estado });
    // Bitacora best-effort (nunca revierte el guardado): evento y estado, sin variables ni nombre de la plantilla.
    await repo.registrarAuditoria({ organizationId, actorUserId: c.get("userId"), action: "configuracion.whatsapp_plantilla_guardada", entityType: "configuracion", entityId: null, campo: `whatsapp_plantilla.${evento.evento}`, antes: null, despues: validada.valor.estado });
    const { items } = await repo.listWhatsappTemplates(organizationId);
    return c.json({ disponible: true, plantilla: items.find((i) => i.evento === evento.evento) ?? null });
  });

  app.delete(porEvento, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const evento = eventoOrThrow(c.req.param("evento"));
    const organizationId = c.get("organizationId");
    const repo = deps.citasRepo(c.get("db"));
    const resultado = await repo.deleteWhatsappTemplate(organizationId, evento.evento);
    if (resultado === "forbidden") throw Errors.forbidden();
    if (resultado === "unavailable") throw Errors.serviceUnavailable("Las plantillas de WhatsApp todavía no están disponibles en este ambiente (migración pendiente).");
    if (resultado === "not_found") throw Errors.notFound("Ese evento no tiene plantilla guardada.");
    logEvent(c, "info", "citas_admin_whatsapp_plantilla_eliminada", { actorUserId: c.get("userId"), organizationId, eventoPlantilla: evento.evento });
    await repo.registrarAuditoria({ organizationId, actorUserId: c.get("userId"), action: "configuracion.whatsapp_plantilla_eliminada", entityType: "configuracion", entityId: null, campo: `whatsapp_plantilla.${evento.evento}`, antes: null, despues: null });
    return c.json({ ok: true });
  });

  return app;
}
