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
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  AGENTE_LIMITES,
  MOTIVOS_ESCALACION_DESACTIVABLES,
  PERFILES_AGENTE_WHATSAPP,
  STAFF_INVITE_ROLES,
  TONOS_AGENTE_WHATSAPP,
  RestaurantesConfigUnavailableError,
  WhatsAppAgentConfigConflictError,
  configPorDefectoDelPerfil,
  diferenciasConfigAgente,
  diffLineasPrompt,
  fotoConfigAgente,
  previewPromptAgente,
  validarConfigAgenteWhatsapp,
  valoresPorOmisionDelPerfil,
} from "@atiende/domain-restaurantes";
import type { BranchTimezoneConfig, KnownZone, WhatsAppAgentConfigAccion, WhatsAppAgentConfigInput, WhatsAppAgentConfigRow } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { conAvisoOnboardingListo } from "./onboarding-aviso.ts";

interface UpsertWhatsappConfigBody {
  readonly phoneNumberId?: unknown;
}

interface CreateKnownZoneBody {
  readonly name?: unknown;
  readonly lat?: unknown;
  readonly lng?: unknown;
}

interface UpsertZonaHorariaBody {
  readonly zona_horaria?: unknown;
}

// `phone_number_id` real de Meta Cloud API es un identificador numérico de la
// plataforma (no el número telefónico en sí) -- dígitos, longitud generosa
// (Meta usa IDs de hasta ~20 dígitos hoy, este tope deja margen sin abrir la
// puerta a un payload arbitrariamente largo).
const PHONE_NUMBER_ID_RE = /^\d{5,32}$/;

function serializeKnownZone(zone: KnownZone) {
  return { id: zone.id, name: zone.name, lat: zone.lat, lng: zone.lng, createdAt: zone.createdAt };
}

/** FASE 3 (producto) -- mismo criterio EXACTO que `citas/admin.ts::optionalTimeZone`
 * (leído primero como plantilla) -- valida que el string sea un timezone IANA real
 * ANTES de escribir la fila. `null` es un valor válido explícito aquí (a
 * diferencia de `optionalTimeZone`, que nunca acepta null porque su columna es
 * NOT NULL con default) -- "borra la configuración, vuelve al default de
 * plataforma", igual que `configuracion.ts` de despachos. */
function optionalNullableTimeZone(value: unknown, field = "zona_horaria"): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100) {
    throw Errors.validation(`${field}: se esperaba un texto de 1 a 100 caracteres, o null.`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw Errors.validation(`${field}: "${value}" no es un timezone IANA válido (ej. "America/Mexico_City").`);
  }
  return value;
}

interface UpsertAgenteWhatsappBody {
  readonly alcance?: unknown;
  readonly perfil?: unknown;
  readonly agentName?: unknown;
  readonly businessName?: unknown;
  readonly toneStyle?: unknown;
  readonly deliveryTimeText?: unknown;
  readonly greetingText?: unknown;
  readonly salsasText?: unknown;
  readonly promosText?: unknown;
  readonly escalationReasonsOff?: unknown;
  /** Version que la pantalla vio al cargar (0 = no habia fila); si ya no es la vigente, 409. Opcional. */
  readonly versionEsperada?: unknown;
}

function parseVersionEsperada(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) throw Errors.validation("versionEsperada: entero >= 0 o null.");
  return value;
}

function serializeAgenteWhatsapp(row: WhatsAppAgentConfigRow | null) {
  return row
    ? {
        perfil: row.perfil,
        agentName: row.agentName,
        businessName: row.businessName,
        toneStyle: row.toneStyle,
        deliveryTimeText: row.deliveryTimeText,
        greetingText: row.greetingText ?? null,
        salsasText: row.salsasText ?? null,
        promosText: row.promosText ?? null,
        escalationReasonsOff: row.escalationReasonsOff ?? [],
        // null = base sin la migracion 033 (no hay version ni historial).
        version: row.version ?? null,
      }
    : null;
}

function serializeZonaHoraria(config: BranchTimezoneConfig) {
  return { zonaHoraria: config.zonaHoraria };
}

export function restaurantesAdminConfigRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const whatsappPath = "/v1/restaurantes/:propertyId/admin/config/whatsapp";
  const zonasPath = "/v1/restaurantes/:propertyId/admin/config/zonas";
  const zonaItemPath = "/v1/restaurantes/:propertyId/admin/config/zonas/:zoneId";
  // FASE 3 (producto) -- zona horaria por negocio (migración 022,
  // `restaurantes.branch_detail.zona_horaria`). A diferencia de whatsapp/zonas
  // (organization-scoped), esto es POR SUCURSAL -- mismo grano que
  // `findBranchZonaHoraria`/`upsertBranchZonaHoraria`.
  const zonaHorariaPath = "/v1/restaurantes/:propertyId/admin/config/zona-horaria";

  app.use(whatsappPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(zonasPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use(zonaItemPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  // Perfil del agente de WhatsApp (migracion 029): por organizacion o por sucursal.
  const agenteWhatsappPath = "/v1/restaurantes/:propertyId/admin/config/agente-whatsapp";
  const agenteSub = { opciones: `${agenteWhatsappPath}/opciones`, vistaPrevia: `${agenteWhatsappPath}/vista-previa`, historial: `${agenteWhatsappPath}/historial`, restablecer: `${agenteWhatsappPath}/restablecer` };
  for (const path of [agenteWhatsappPath, ...Object.values(agenteSub)]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }
  app.use(zonaHorariaPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

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

  // ---- FASE 3 (producto) -- zona horaria por negocio (migración 022). Nunca
  // 404: una sucursal que nunca configuró zona horaria (columna NULL, o base sin
  // la migración 022 -- ver `findBranchZonaHoraria`, degrada a null, nunca
  // lanza) se ve como `zonaHoraria: null`, mismo criterio que
  // `GET .../admin/config/whatsapp`. ----
  app.get(zonaHorariaPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const propertyId = c.req.param("propertyId");
    const config = await deps.restaurantesRepo(c.get("db")).findBranchZonaHoraria(propertyId);
    return c.json(serializeZonaHoraria(config));
  });

  app.patch(zonaHorariaPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const staffId = c.get("userId");

    const raw = await readJsonCapped<UpsertZonaHorariaBody>(c.req.raw, 1 * 1024);
    const zonaHoraria = optionalNullableTimeZone(raw.zona_horaria);
    if (zonaHoraria === undefined) throw Errors.validation("zona_horaria: campo requerido -- un timezone IANA (string) o null.");

    const repo = deps.restaurantesRepo(c.get("db"));
    const antes = await repo.findBranchZonaHoraria(propertyId);

    let actualizado: BranchTimezoneConfig;
    try {
      actualizado = await repo.upsertBranchZonaHoraria(propertyId, zonaHoraria);
    } catch (err) {
      if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }

    logEvent(c, "info", "restaurantes_admin_config_zona_horaria_actualizada", { actorUserId: staffId, organizationId, propertyId });

    await repo.registrarAuditoria({
      organizationId,
      actorUserId: staffId,
      action: "configuracion.zona_horaria_actualizada",
      entityType: "configuracion",
      entityId: propertyId,
      campo: "zonaHoraria",
      antes: antes.zonaHoraria,
      despues: actualizado.zonaHoraria,
    });

    return c.json(serializeZonaHoraria(actualizado));
  });

  // ---- Perfil del agente de WhatsApp (migracion 029). GET nunca 404: sin fila (o base sin migrar, la lectura
  // degrada a null) el agente que contesta es el generico de siempre. ----
  app.get(agenteWhatsappPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const repo = deps.restaurantesRepo(c.get("db"));
    const organizacion = await repo.findWhatsAppAgentConfig(organizationId, null);
    const efectivaSucursal = await repo.findWhatsAppAgentConfig(organizationId, propertyId);
    return c.json({ organizacion: serializeAgenteWhatsapp(organizacion), sucursal: serializeAgenteWhatsapp(efectivaSucursal?.propertyId === propertyId ? efectivaSucursal : null) });
  });

  function alcanceDe(raw: unknown, propertyId: string): string | null {
    if (raw !== "organizacion" && raw !== "sucursal") throw Errors.validation('alcance: "organizacion" o "sucursal".');
    return raw === "sucursal" ? propertyId : null;
  }

  function validarCuerpo(raw: UpsertAgenteWhatsappBody): WhatsAppAgentConfigInput {
    const validada = validarConfigAgenteWhatsapp(raw);
    if (!validada.ok) throw Errors.validation(validada.error);
    return validada.valor;
  }

  async function guardar(
    c: Context<CoreAuthHonoEnv>,
    alcancePropertyId: string | null,
    config: WhatsAppAgentConfigInput,
    accion: WhatsAppAgentConfigAccion,
    versionEsperada: number | null,
    auditoria: string,
  ): Promise<WhatsAppAgentConfigRow> {
    const organizationId = c.get("organizationId");
    const staffId = c.get("userId");
    const repo = deps.restaurantesRepo(c.get("db"));
    const anterior = await repo.findWhatsAppAgentConfigExacta(organizationId, alcancePropertyId);
    let actualizado: WhatsAppAgentConfigRow;
    try {
      actualizado = await conAvisoOnboardingListo(deps, c, organizationId, () => repo.guardarWhatsAppAgentConfig(organizationId, alcancePropertyId, config, { accion, actorUserId: staffId, versionEsperada }));
    } catch (err) {
      if (err instanceof RestaurantesConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
      if (err instanceof WhatsAppAgentConfigConflictError) throw Errors.conflict(err.message);
      throw err;
    }
    logEvent(c, "info", "restaurantes_admin_config_agente_whatsapp_actualizado", { actorUserId: staffId, organizationId, propertyId: alcancePropertyId, accion, version: actualizado.version ?? null });
    await repo.registrarAuditoria({
      organizationId,
      actorUserId: staffId,
      action: auditoria,
      entityType: "configuracion",
      entityId: alcancePropertyId,
      campo: "perfil",
      antes: anterior?.perfil ?? null,
      despues: actualizado.perfil,
    });
    return actualizado;
  }

  app.put(agenteWhatsappPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const propertyId = c.req.param("propertyId") ?? "";
    const raw = await readJsonCapped<UpsertAgenteWhatsappBody>(c.req.raw, 4 * 1024);
    const alcancePropertyId = alcanceDe(raw.alcance, propertyId);
    const config = validarCuerpo(raw);
    const actualizado = await guardar(c, alcancePropertyId, config, "actualizado", parseVersionEsperada(raw.versionEsperada), "configuracion.agente_whatsapp_actualizado");
    return c.json(serializeAgenteWhatsapp(actualizado));
  });

  // Valores por omision de cada perfil, limites y motivos que se pueden apagar: la pantalla los muestra como sugerencia.
  app.get(agenteSub.opciones, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    return c.json({
      perfiles: PERFILES_AGENTE_WHATSAPP.map((p) => valoresPorOmisionDelPerfil(p)),
      tonos: TONOS_AGENTE_WHATSAPP,
      motivosDesactivables: MOTIVOS_ESCALACION_DESACTIVABLES,
      limites: AGENTE_LIMITES,
    });
  });

  // Vista previa de SOLO LECTURA: el prompt que tendria el agente con el borrador, contra el vigente, y las diferencias.
  // No escribe nada (ni bitacora).
  app.post(agenteSub.vistaPrevia, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    const raw = await readJsonCapped<UpsertAgenteWhatsappBody>(c.req.raw, 4 * 1024);
    const alcancePropertyId = alcanceDe(raw.alcance, propertyId);
    const borrador = validarCuerpo(raw);
    const repo = deps.restaurantesRepo(c.get("db"));
    const exacta = await repo.findWhatsAppAgentConfigExacta(organizationId, alcancePropertyId);
    const vigente = await repo.findWhatsAppAgentConfig(organizationId, alcancePropertyId);
    const promptNuevo = previewPromptAgente(borrador);
    const promptVigente = previewPromptAgente(vigente ?? configPorDefectoDelPerfil("generico"));
    return c.json({
      prompt: promptNuevo,
      promptVigente,
      diferenciasCampos: diferenciasConfigAgente(fotoConfigAgente(exacta), fotoConfigAgente(borrador)!),
      diferenciasPrompt: diffLineasPrompt(promptVigente, promptNuevo),
      version: exacta?.version ?? (exacta ? 1 : 0),
    });
  });

  app.get(agenteSub.historial, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    const alcance = c.req.query("alcance") ?? "organizacion";
    const alcancePropertyId = alcanceDe(alcance, propertyId);
    const limite = Number(c.req.query("limite") ?? "20");
    if (!Number.isInteger(limite) || limite < 1 || limite > 100) throw Errors.validation("limite: entero entre 1 y 100.");
    const entradas = await deps.restaurantesRepo(c.get("db")).listWhatsAppAgentConfigHistorial(organizationId, alcancePropertyId, limite);
    return c.json({
      entradas: entradas.map((e) => ({ version: e.version, accion: e.accion, anterior: e.anterior, nuevo: e.nuevo, actorUserId: e.actorUserId, actorNombre: e.actorNombre, creadoEn: e.creadoAt })),
    });
  });

  // "Volver al perfil por defecto": deja en blanco todos los textos editables (el perfil se conserva) y lo anota en el
  // historial como `restablecido`. Sin config propia en ese alcance no hay nada que restablecer (404).
  app.post(agenteSub.restablecer, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId") ?? "";
    const raw = await readJsonCapped<{ alcance?: unknown; versionEsperada?: unknown }>(c.req.raw, 1024);
    const alcancePropertyId = alcanceDe(raw.alcance, propertyId);
    const actual = await deps.restaurantesRepo(c.get("db")).findWhatsAppAgentConfigExacta(organizationId, alcancePropertyId);
    if (!actual) throw Errors.notFound("Ese alcance no tiene una configuración propia que restablecer.");
    const actualizado = await guardar(c, alcancePropertyId, configPorDefectoDelPerfil(actual.perfil), "restablecido", parseVersionEsperada(raw.versionEsperada), "configuracion.agente_whatsapp_restablecido");
    return c.json(serializeAgenteWhatsapp(actualizado));
  });

  return app;
}
