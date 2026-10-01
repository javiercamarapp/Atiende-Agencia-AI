// C-04 -- /v1/citas/properties/:propertyId/admin/whatsapp-mensajes: configuracion de los mensajes de WhatsApp de citas
// (plantillas de recordatorio / confirmacion / cancelacion / reagendado, anticipacion y horario de envio) editable desde
// el panel. Mismo patron que el editor del agente de restaurantes (#254): GET, PUT con version optimista, vista previa de
// SOLO LECTURA con diferencias, historial y restablecer.
//
// Autorizacion: owner/admin unicamente (`STAFF_INVITE_ROLES`), tanto para leer como para escribir (mismo umbral que la
// bitacora y el staff). Todas las rutas corren en la sesion de STAFF autenticado; la escritura real la valida de nuevo la
// funcion SQL `citas.save_whatsapp_message_config` (rol owner/admin de la organizacion, version, historial atomico).
//
// Compatibilidad con la base sin migrar (migracion 026): el repositorio degrada con SAVEPOINT. GET responde 200 con
// `disponible: false` y los valores de fabrica; PUT/restablecer responden 503; el recordatorio sigue saliendo como siempre.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ANTICIPACION_POR_OMISION_HORAS,
  MENSAJE_ETIQUETAS,
  MENSAJE_KINDS,
  MENSAJE_LIMITES,
  MENSAJES_CONFIG_POR_OMISION,
  STAFF_INVITE_ROLES,
  diferenciasConfigMensajes,
  fotoConfigMensajes,
  previewMensajes,
  textoPorOmision,
  validarConfigMensajes,
  variablesDe,
} from "@atiende/domain-citas";
import type { WhatsappMessageConfig } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

function parseVersionEsperada(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw Errors.validation("versionEsperada: entero >= 0 (0 si todavia no hay configuracion guardada).");
  }
  return value;
}

function validarCuerpo(raw: unknown): WhatsappMessageConfig {
  const validada = validarConfigMensajes(raw);
  if (!validada.ok) throw Errors.validation(validada.error);
  return validada.valor;
}

function serializar(record: { config: WhatsappMessageConfig; version: number; updatedAt: string; updatedBy: string | null } | null) {
  const config = record?.config ?? MENSAJES_CONFIG_POR_OMISION;
  return {
    version: record?.version ?? 0,
    config,
    actualizadoEn: record?.updatedAt ?? null,
    actualizadoPor: record?.updatedBy ?? null,
    vistaPrevia: previewMensajes(config),
  };
}

export function citasWhatsappMensajesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/v1/citas/properties/:propertyId/admin/whatsapp-mensajes";
  const sub = { opciones: `${base}/opciones`, vistaPrevia: `${base}/vista-previa`, historial: `${base}/historial`, restablecer: `${base}/restablecer` };
  for (const path of [base, ...Object.values(sub)]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  // GET nunca 404: sin fila (o base sin migrar) devuelve los valores de fabrica con `version: 0`.
  app.get(base, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const { disponible, record } = await deps.citasRepo(c.get("db")).getWhatsappMessageConfig(c.get("organizationId"));
    return c.json({ disponible, ...serializar(record) });
  });

  // Catalogo para la pantalla: tipos, etiquetas, variables permitidas, texto de fabrica y limites.
  app.get(sub.opciones, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    return c.json({
      mensajes: MENSAJE_KINDS.map((kind) => ({ kind, etiqueta: MENSAJE_ETIQUETAS[kind], variables: variablesDe(kind), textoPorOmision: textoPorOmision(kind) })),
      textoRecordatorioOtraAnticipacion: textoPorOmision("recordatorio", ANTICIPACION_POR_OMISION_HORAS + 1),
      porOmision: MENSAJES_CONFIG_POR_OMISION,
      limites: MENSAJE_LIMITES,
    });
  });

  // Vista previa de SOLO LECTURA: como se veria cada mensaje con el borrador y que cambia contra lo vigente. No escribe nada.
  app.post(sub.vistaPrevia, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const borrador = validarCuerpo(await readJsonCapped<unknown>(c.req.raw, 8 * 1024));
    const { record } = await deps.citasRepo(c.get("db")).getWhatsappMessageConfig(c.get("organizationId"));
    return c.json({
      vistaPrevia: previewMensajes(borrador),
      diferencias: diferenciasConfigMensajes(record ? fotoConfigMensajes(record.config) : null, fotoConfigMensajes(borrador)),
      version: record?.version ?? 0,
    });
  });

  async function guardar(c: Context<CoreAuthHonoEnv>, config: WhatsappMessageConfig, accion: "actualizado" | "restablecido", versionEsperada: number) {
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");
    const repo = deps.citasRepo(c.get("db"));
    const resultado = await repo.saveWhatsappMessageConfig(organizationId, versionEsperada, accion, config);
    if (resultado.status === "conflict") throw Errors.conflict("La configuracion cambio mientras la editabas. Recarga la pagina y vuelve a intentar.");
    if (resultado.status === "forbidden") throw Errors.forbidden();
    if (resultado.status === "unavailable") throw Errors.serviceUnavailable("La edicion de mensajes todavia no esta disponible en este ambiente (migracion pendiente).");
    logEvent(c, "info", "citas_admin_whatsapp_mensajes_guardado", { actorUserId: staffId, organizationId, accion, version: resultado.version });
    // Bitacora best-effort (nunca revierte el guardado): version anterior y nueva, sin el texto de los mensajes.
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: staffId,
      action: accion === "restablecido" ? "configuracion.whatsapp_mensajes_restablecido" : "configuracion.whatsapp_mensajes_actualizado",
      entityType: "configuracion",
      entityId: null,
      campo: "whatsapp_mensajes.version",
      antes: String(versionEsperada),
      despues: String(resultado.version),
    });
    const { record } = await repo.getWhatsappMessageConfig(organizationId);
    return serializar(record);
  }

  app.put(base, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
    const config = validarCuerpo(raw);
    return c.json({ disponible: true, ...(await guardar(c, config, "actualizado", parseVersionEsperada(raw.versionEsperada))) });
  });

  // "Volver al default": todos los textos y horarios a los valores de fabrica; queda en el historial como `restablecido`.
  app.post(sub.restablecer, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const raw = await readJsonCapped<{ versionEsperada?: unknown }>(c.req.raw, 1024);
    return c.json({ disponible: true, ...(await guardar(c, MENSAJES_CONFIG_POR_OMISION, "restablecido", parseVersionEsperada(raw.versionEsperada))) });
  });

  app.get(sub.historial, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const limite = Number(c.req.query("limite") ?? "20");
    if (!Number.isInteger(limite) || limite < 1 || limite > 100) throw Errors.validation("limite: entero entre 1 y 100.");
    const { disponible, items } = await deps.citasRepo(c.get("db")).listWhatsappMessageConfigHistory(c.get("organizationId"), limite);
    return c.json({
      disponible,
      entradas: items.map((e) => ({
        version: e.version,
        accion: e.accion,
        anterior: e.anterior,
        nuevo: e.nuevo,
        diferencias: diferenciasConfigMensajes(e.anterior, e.nuevo),
        actorUserId: e.actorId,
        actorNombre: e.actorNombre,
        creadoEn: e.createdAt,
      })),
    });
  });

  return app;
}
