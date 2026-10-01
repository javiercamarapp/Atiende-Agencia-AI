// PM PR-9 (restaurantes) -- seguimiento de solicitudes de derechos ARCO y configuracion de privacidad
// desde el panel. Las solicitudes las abre el titular por WhatsApp o voz (fast-path determinista, ver
// packages/domain-restaurantes/src/privacidad/arco-intent.ts) y viven en `restaurantes.data_rights_requests`
// (packages/domain-restaurantes/migrations/030_privacidad_arco_aviso_retencion.sql). Aquí el staff
// owner/admin las consulta y las mueve de estado; la función SQL valida de nuevo
// rol, organización y transición (defensa en profundidad). Documentación operativa,
// no asesoría legal.
//
//   GET   .../admin/privacidad/solicitudes             lista paginada (+ vencimiento)
//   GET   .../admin/privacidad/solicitudes/:id/eventos bitácora de una solicitud
//   PATCH .../admin/privacidad/solicitudes/:id/estado  en_proceso|bloqueada|resuelta|rechazada
//   GET   .../admin/privacidad/configuracion           aviso, retención y consentimiento de grabación
//   PUT   .../admin/privacidad/configuracion           (owner/admin)
//
// Solo owner/admin (los teléfonos de los titulares no son para todo el staff).
// Base sin migrar: la lista responde `disponible:false` y el PATCH 503 explícito --
// nunca un 500 ni una lista vacía que parezca real.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  DATA_RIGHT_STAFF_TARGET_STATUSES,
  DATA_RIGHT_STATUSES,
  DATA_RIGHT_TYPES,
  DATA_RIGHTS_EXECUTION_DAYS,
  DATA_RIGHTS_RESPONSE_DAYS,
  dataRightsDeadlineState,
  dataRightsFolio,
  PRIVACY_CONFIG_POR_DEFECTO,
  validatePrivacyConfig,
} from "@atiende/domain-restaurantes";
import type { DataRightStaffTargetStatus, DataRightStatus, DataRightType, PrivacidadRepository, RestaurantesRole } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const PRIVACIDAD_ROLES: readonly RestaurantesRole[] = ["owner", "admin"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTERO_RE = /^\d+$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const NOTA_MAX = 1000;

function parseEntero(raw: string, field: string): number {
  if (!ENTERO_RE.test(raw)) throw Errors.validation(`${field}: se esperaba un entero.`);
  return Number.parseInt(raw, 10);
}

function parseEstadoFiltro(raw: string | undefined): DataRightStatus | null {
  if (!raw) return null;
  if (!(DATA_RIGHT_STATUSES as readonly string[]).includes(raw)) throw Errors.validation(`estado: se esperaba uno de ${DATA_RIGHT_STATUSES.join(", ")}.`);
  return raw as DataRightStatus;
}

function parseDerechoFiltro(raw: string | undefined): DataRightType | null {
  if (!raw) return null;
  if (!(DATA_RIGHT_TYPES as readonly string[]).includes(raw)) throw Errors.validation(`derecho: se esperaba uno de ${DATA_RIGHT_TYPES.join(", ")}.`);
  return raw as DataRightType;
}

export function restaurantesPrivacidadRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const root = "/v1/restaurantes/:propertyId/admin/privacidad";
  const base = `${root}/solicitudes`;
  app.use(`${root}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  function privacidadRepo(c: { get(key: "db"): Parameters<NonNullable<AppDeps["privacidadRepo"]>>[0] }): PrivacidadRepository {
    if (!deps.privacidadRepo) throw Errors.serviceUnavailable("La privacidad no está disponible en este despliegue.");
    return deps.privacidadRepo(c.get("db"));
  }

  app.get(base, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    const limit = limitRaw === undefined ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, parseEntero(limitRaw, "limit"));
    if (limit < 1) throw Errors.validation("limit: se esperaba un entero >= 1.");
    const offset = offsetRaw === undefined ? 0 : parseEntero(offsetRaw, "offset");
    const estado = parseEstadoFiltro(c.req.query("estado"));
    const derecho = parseDerechoFiltro(c.req.query("derecho"));

    const repo = privacidadRepo(c);
    const pagina = await repo.listDataRightsRequests(c.get("organizationId"), { status: estado, rightType: derecho }, { limit, offset });
    const now = new Date();
    return c.json(
      {
        disponible: pagina.disponible,
        total: pagina.total,
        nextOffset: pagina.nextOffset,
        plazos: { respuestaDias: DATA_RIGHTS_RESPONSE_DAYS, ejecucionDias: DATA_RIGHTS_EXECUTION_DAYS },
        items: pagina.items.map((r) => ({
          id: r.id,
          folio: dataRightsFolio(r.id),
          telefono: r.customerPhone,
          derecho: r.rightType,
          canal: r.channel,
          identidadVerificadaPor: r.identityBasis,
          estado: r.status,
          detalle: r.detail,
          solicitadaEn: r.requestedAt,
          confirmadaEn: r.confirmedAt,
          respuestaVenceEn: r.responseDueAt,
          ejecucionVenceEn: r.executionDueAt,
          resueltaEn: r.resolvedAt,
          notaResolucion: r.resolutionNote,
          atendidaPor: r.handledBy,
          plazo: dataRightsDeadlineState(r, now),
        })),
      },
      200,
    );
  });

  app.get(`${base}/:requestId/eventos`, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const requestId = c.req.param("requestId");
    if (!UUID_RE.test(requestId)) throw Errors.validation("requestId inválido.");
    const eventos = await privacidadRepo(c).listDataRightsEvents(c.get("organizationId"), requestId);
    if (eventos === null) return c.json({ disponible: false, items: [] }, 200);
    return c.json(
      {
        disponible: true,
        items: eventos.map((e) => ({
          id: e.id,
          actor: e.actorKind,
          evento: e.event,
          desde: e.fromStatus,
          hacia: e.toStatus,
          nota: e.note,
          creadoEn: e.createdAt,
        })),
      },
      200,
    );
  });

  app.patch(`${base}/:requestId/estado`, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const requestId = c.req.param("requestId");
    if (!UUID_RE.test(requestId)) throw Errors.validation("requestId inválido.");
    const body = await readJsonCapped<{ estado?: unknown; nota?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof body.estado !== "string" || !(DATA_RIGHT_STAFF_TARGET_STATUSES as readonly string[]).includes(body.estado)) {
      throw Errors.validation(`estado: se esperaba uno de ${DATA_RIGHT_STAFF_TARGET_STATUSES.join(", ")}.`);
    }
    let nota: string | null = null;
    if (body.nota !== undefined && body.nota !== null) {
      if (typeof body.nota !== "string") throw Errors.validation("nota: se esperaba texto.");
      const trimmed = body.nota.trim();
      if (trimmed.length > NOTA_MAX) throw Errors.validation(`nota: máximo ${NOTA_MAX} caracteres.`);
      nota = trimmed === "" ? null : trimmed;
    }
    const estado = body.estado as DataRightStaffTargetStatus;
    if (estado === "rechazada" && !nota) throw Errors.validation("Para rechazar una solicitud indica el motivo en `nota`.");

    const result = await privacidadRepo(c).updateDataRightsRequestStatus(c.get("organizationId"), requestId, estado, nota);
    switch (result.outcome) {
      case "updated":
        return c.json({ id: result.id, estado: result.status }, 200);
      case "not_found":
        throw Errors.notFound("Solicitud no encontrada.");
      case "invalid_transition":
        throw Errors.conflict("Esa solicitud no puede pasar a ese estado desde su estado actual.");
      case "invalid_input":
        throw Errors.validation("Parámetros inválidos para actualizar la solicitud.");
      case "forbidden":
        throw Errors.forbidden();
      case "unavailable":
        throw Errors.serviceUnavailable("El seguimiento de solicitudes ARCO todavía no está disponible en este ambiente (migración pendiente).");
    }
  });

  // ---- configuración de privacidad (aviso, retención, consentimiento de grabación) ----
  app.get(`${root}/configuracion`, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const config = await privacidadRepo(c).getPrivacyConfig(c.get("organizationId"));
    return c.json({ configuracion: serializeConfig(config), porDefecto: serializeConfig(PRIVACY_CONFIG_POR_DEFECTO) }, 200);
  });

  app.put(`${root}/configuracion`, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const body = await readJsonCapped<Record<string, unknown>>(c.req.raw, 4 * 1024);
    const responsibleName = nullableText(body.responsable, "responsable");
    const noticeUrl = nullableText(body.avisoUrl, "avisoUrl");
    const noticeVersion = typeof body.avisoVersion === "string" ? body.avisoVersion : PRIVACY_CONFIG_POR_DEFECTO.noticeVersion;
    const conversationRetentionDays = body.retencionConversacionesDias ?? PRIVACY_CONFIG_POR_DEFECTO.conversationRetentionDays;
    const voiceRetentionDays = body.retencionVozDias ?? PRIVACY_CONFIG_POR_DEFECTO.voiceRetentionDays;
    const recordingConsentRequired = body.exigirConsentimientoGrabacion ?? PRIVACY_CONFIG_POR_DEFECTO.recordingConsentRequired;
    if (typeof conversationRetentionDays !== "number" || typeof voiceRetentionDays !== "number") throw Errors.validation("Los días de retención deben ser números enteros.");
    if (typeof recordingConsentRequired !== "boolean") throw Errors.validation("exigirConsentimientoGrabacion: se esperaba true o false.");
    const entrada = { responsibleName, noticeUrl, noticeVersion, conversationRetentionDays, voiceRetentionDays, recordingConsentRequired };
    const invalido = validatePrivacyConfig(entrada);
    if (invalido) throw Errors.validation(invalido);

    const result = await privacidadRepo(c).updatePrivacyConfig(c.get("organizationId"), entrada);
    switch (result.outcome) {
      case "updated":
        return c.json({ configuracion: serializeConfig({ ...entrada, configurada: true }) }, 200);
      case "forbidden":
        throw Errors.forbidden();
      case "unavailable":
        throw Errors.serviceUnavailable("La configuración de privacidad todavía no está disponible en este ambiente (migración pendiente).");
    }
  });

  return app;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw Errors.validation(`${field}: se esperaba texto o null.`);
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function serializeConfig(config: { responsibleName: string | null; noticeUrl: string | null; noticeVersion: string; conversationRetentionDays: number; voiceRetentionDays: number; recordingConsentRequired: boolean; configurada: boolean }) {
  return {
    responsable: config.responsibleName,
    avisoUrl: config.noticeUrl,
    avisoVersion: config.noticeVersion,
    retencionConversacionesDias: config.conversationRetentionDays,
    retencionVozDias: config.voiceRetentionDays,
    exigirConsentimientoGrabacion: config.recordingConsentRequired,
    configurada: config.configurada,
  };
}
