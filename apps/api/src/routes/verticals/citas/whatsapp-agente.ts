// C-15 -- /v1/citas/properties/:propertyId/admin/whatsapp-agente: conectar el numero de WhatsApp del negocio y editar la
// personalidad del agente (nombre, tono, mensaje de bienvenida y reglas) desde el panel. Mismo patron que los mensajes de C-04
// (whatsapp-mensajes.ts) y el editor del agente de restaurantes (#254): GET, PUT con version optimista, vista previa de SOLO
// LECTURA, restablecer.
//
// Autorizacion: owner/admin unicamente (`STAFF_INVITE_ROLES`), tanto para leer como para escribir. La escritura real la valida de
// nuevo la funcion SQL (rol owner/admin de la organizacion, version, unicidad del numero). Todas las rutas corren en la sesion de
// STAFF autenticado.
//
// Estados honestos: el numero se REGISTRA (la plataforma enruta por el), pero desde aqui no se puede comprobar que Meta lo
// reconozca ni, sin la credencial de envio de la plataforma, responder: la respuesta lo dice en `conexion.estado` y nunca
// afirma "conectado y verificado". Compatibilidad con la base sin migrar (migracion 028): el repositorio degrada con SAVEPOINT;
// GET responde 200 con `disponible: false` y los valores de fabrica; las escrituras responden 503.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  AGENTE_CONFIG_POR_OMISION,
  AGENTE_LIMITES,
  STAFF_INVITE_ROLES,
  TONOS_AGENTE_CITAS,
  TONO_ETIQUETAS,
  diferenciasConfigAgente,
  estadoConexion,
  fotoConfigAgente,
  previewPromptAgente,
  validarConfigAgente,
  validarPhoneNumberId,
} from "@atiende/domain-citas";
import type { WhatsappAgentConfig, WhatsappAgentConfigRecord, WhatsappConnection } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

function parseVersionEsperada(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw Errors.validation("versionEsperada: entero >= 0 (0 si todavía no hay configuración guardada).");
  }
  return value;
}

function validarCuerpo(raw: unknown): WhatsappAgentConfig {
  const validada = validarConfigAgente(raw);
  if (!validada.ok) throw Errors.validation(validada.error);
  return validada.valor;
}

/** "•••• 0987": la bitacora y los logs nunca guardan el identificador completo. */
function enmascarar(phoneNumberId: string | null): string {
  return phoneNumberId ? `••••${phoneNumberId.slice(-4)}` : "(sin número)";
}

const NOTA_ESTADO = {
  sin_numero: "Todavía no hay un número conectado: el agente no recibe ni envía mensajes.",
  pausado: "El número está pausado: no se enrutan los mensajes entrantes y los avisos no salen.",
  sin_credenciales_de_envio:
    "El número está registrado, pero la plataforma todavía no tiene la credencial de envío de Meta: se pueden recibir mensajes, pero el agente no podrá responder ni mandar avisos hasta que se configure.",
  registrado: "Número registrado. No es una verificación con Meta: confirma con un mensaje de prueba desde tu WhatsApp.",
} as const;

export function citasWhatsappAgenteRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const base = "/v1/citas/properties/:propertyId/admin/whatsapp-agente";
  const sub = { vistaPrevia: `${base}/vista-previa`, restablecer: `${base}/restablecer`, conexion: `${base}/conexion` };
  for (const path of [base, ...Object.values(sub)]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  function serializarConexion(conexion: WhatsappConnection | null) {
    const credencialDeEnvio = deps.env.whatsappAccessToken !== null;
    const estado = estadoConexion(conexion, credencialDeEnvio);
    return {
      numero: conexion ? { phoneNumberId: conexion.phoneNumberId, activo: conexion.isActive } : null,
      estado,
      credencialDeEnvioDisponible: credencialDeEnvio,
      nota: NOTA_ESTADO[estado],
    };
  }

  function serializarAgente(record: WhatsappAgentConfigRecord | null) {
    const config = record?.config ?? AGENTE_CONFIG_POR_OMISION;
    return { version: record?.version ?? 0, config, actualizadoEn: record?.updatedAt ?? null, actualizadoPor: record?.updatedBy ?? null, promptDeMuestra: previewPromptAgente(config) };
  }

  const opciones = {
    tonos: TONOS_AGENTE_CITAS.map((valor) => ({ valor, etiqueta: TONO_ETIQUETAS[valor] })),
    limites: AGENTE_LIMITES,
    porOmision: AGENTE_CONFIG_POR_OMISION,
  };

  // GET nunca 404: sin fila (o base sin migrar) devuelve los valores de fabrica con `version: 0`.
  app.get(base, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const repo = deps.citasRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const [{ disponible, record }, conexion] = await Promise.all([repo.getWhatsappAgentConfig(organizationId), repo.getWhatsappConnection(organizationId)]);
    return c.json({ disponible, agente: serializarAgente(record), conexion: serializarConexion(conexion), opciones });
  });

  // Vista previa de SOLO LECTURA: el prompt que usaria el agente con el borrador y que cambia contra lo vigente. No escribe nada.
  app.post(sub.vistaPrevia, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const borrador = validarCuerpo(await readJsonCapped<unknown>(c.req.raw, 8 * 1024));
    const { record } = await deps.citasRepo(c.get("db")).getWhatsappAgentConfig(c.get("organizationId"));
    return c.json({ prompt: previewPromptAgente(borrador), diferencias: diferenciasConfigAgente(record?.config ?? null, borrador), version: record?.version ?? 0 });
  });

  async function guardar(c: Context<CoreAuthHonoEnv>, config: WhatsappAgentConfig, accion: "actualizado" | "restablecido", versionEsperada: number) {
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");
    const repo = deps.citasRepo(c.get("db"));
    const resultado = await repo.saveWhatsappAgentConfig(organizationId, versionEsperada, accion, config);
    if (resultado.status === "conflict") throw Errors.conflict("La configuración cambió mientras la editabas. Recarga la página y vuelve a intentar.");
    if (resultado.status === "forbidden") throw Errors.forbidden();
    if (resultado.status === "unavailable") throw Errors.serviceUnavailable("La edición del agente todavía no está disponible en este ambiente (migración pendiente).");
    logEvent(c, "info", "citas_admin_whatsapp_agente_guardado", { actorUserId: staffId, organizationId, accion, version: resultado.version });
    // Bitacora best-effort (nunca revierte el guardado): version anterior y nueva, sin el texto de la personalidad.
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: staffId,
      action: accion === "restablecido" ? "configuracion.whatsapp_agente_restablecido" : "configuracion.whatsapp_agente_actualizado",
      entityType: "configuracion",
      entityId: null,
      campo: "whatsapp_agente.version",
      antes: String(versionEsperada),
      despues: String(resultado.version),
    });
    const { record } = await repo.getWhatsappAgentConfig(organizationId);
    return serializarAgente(record);
  }

  app.put(base, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 8 * 1024);
    const config = validarCuerpo(raw);
    return c.json({ disponible: true, agente: await guardar(c, config, "actualizado", parseVersionEsperada(raw.versionEsperada)) });
  });

  // "Volver al default": nombre, tono, bienvenida y reglas a los de fabrica.
  app.post(sub.restablecer, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const raw = await readJsonCapped<{ versionEsperada?: unknown }>(c.req.raw, 1024);
    return c.json({ disponible: true, agente: await guardar(c, AGENTE_CONFIG_POR_OMISION, "restablecido", parseVersionEsperada(raw.versionEsperada)) });
  });

  // Conectar / cambiar / pausar el numero.
  app.put(sub.conexion, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const raw = await readJsonCapped<{ phoneNumberId?: unknown; activo?: unknown }>(c.req.raw, 2 * 1024);
    const id = validarPhoneNumberId(raw.phoneNumberId);
    if (!id.ok) throw Errors.validation(id.error);
    if (raw.activo !== undefined && typeof raw.activo !== "boolean") throw Errors.validation("activo: true o false.");
    const activo = raw.activo ?? true;
    const organizationId = c.get("organizationId");
    const repo = deps.citasRepo(c.get("db"));
    const antes = await repo.getWhatsappConnection(organizationId);
    const resultado = await repo.connectWhatsappNumber(organizationId, id.valor, activo);
    if (resultado.status === "forbidden") throw Errors.forbidden();
    if (resultado.status === "invalid") throw Errors.validation("phoneNumberId: solo dígitos, de 5 a 40.");
    if (resultado.status === "in_use") throw Errors.conflict("Ese número ya está conectado a otro negocio.");
    if (resultado.status === "unavailable") throw Errors.serviceUnavailable("Conectar el número todavía no está disponible en este ambiente (migración pendiente).");
    logEvent(c, "info", "citas_admin_whatsapp_numero_conectado", { actorUserId: c.get("userId"), organizationId, activo });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: c.get("userId"),
      action: antes ? "configuracion.whatsapp_numero_actualizado" : "configuracion.whatsapp_numero_conectado",
      entityType: "configuracion",
      entityId: null,
      campo: "whatsapp.numero",
      antes: antes ? `${enmascarar(antes.phoneNumberId)} (${antes.isActive ? "activo" : "pausado"})` : enmascarar(null),
      despues: `${enmascarar(resultado.phoneNumberId)} (${activo ? "activo" : "pausado"})`,
    });
    return c.json({ conexion: serializarConexion(await repo.getWhatsappConnection(organizationId)) });
  });

  app.delete(sub.conexion, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const repo = deps.citasRepo(c.get("db"));
    const antes = await repo.getWhatsappConnection(organizationId);
    const resultado = await repo.disconnectWhatsappNumber(organizationId);
    if (resultado.status === "forbidden") throw Errors.forbidden();
    if (resultado.status === "unavailable") throw Errors.serviceUnavailable("Desconectar el número todavía no está disponible en este ambiente (migración pendiente).");
    if (resultado.removed) {
      logEvent(c, "info", "citas_admin_whatsapp_numero_desconectado", { actorUserId: c.get("userId"), organizationId });
      await repo.registrarAuditoria({
        organizationId,
        actorUserId: c.get("userId"),
        action: "configuracion.whatsapp_numero_desconectado",
        entityType: "configuracion",
        entityId: null,
        campo: "whatsapp.numero",
        antes: enmascarar(antes?.phoneNumberId ?? null),
        despues: enmascarar(null),
      });
    }
    return c.json({ conexion: serializarConexion(await repo.getWhatsappConnection(organizationId)) });
  });

  return app;
}
