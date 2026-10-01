// C-02 (citas) -- seguimiento de solicitudes de derechos ARCO desde el panel.
// Las solicitudes las abre el titular por WhatsApp (fast-path determinista, ver
// packages/domain-citas/src/arco-intent.ts) y viven en `citas.data_rights_requests`
// (packages/domain-citas/migrations/024_citas_data_rights.sql). Aquí el staff
// owner/admin las consulta y las mueve de estado; la función SQL valida de nuevo
// rol, organización y transición (defensa en profundidad). Documentación operativa,
// no asesoría legal.
//
//   GET   .../admin/privacidad/solicitudes            lista paginada (+ vencimiento)
//   GET   .../admin/privacidad/solicitudes/:id/eventos bitácora de una solicitud
//   PATCH .../admin/privacidad/solicitudes/:id/estado   en_proceso|bloqueada|resuelta|rechazada
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
} from "@atiende/domain-citas";
import type { CitasRole, DataRightStaffTargetStatus, DataRightStatus, DataRightType } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const PRIVACIDAD_ROLES: readonly CitasRole[] = ["owner", "admin"];
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

export function citasPrivacidadRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/v1/citas/properties/:propertyId/admin/privacidad/solicitudes";
  app.use(`${base}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    assertVerticalRole(c, PRIVACIDAD_ROLES);
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    const limit = limitRaw === undefined ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, parseEntero(limitRaw, "limit"));
    if (limit < 1) throw Errors.validation("limit: se esperaba un entero >= 1.");
    const offset = offsetRaw === undefined ? 0 : parseEntero(offsetRaw, "offset");
    const estado = parseEstadoFiltro(c.req.query("estado"));
    const derecho = parseDerechoFiltro(c.req.query("derecho"));

    const repo = deps.citasRepo(c.get("db"));
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
    const eventos = await deps.citasRepo(c.get("db")).listDataRightsEvents(c.get("organizationId"), requestId);
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

    const result = await deps.citasRepo(c.get("db")).updateDataRightsRequestStatus(c.get("organizationId"), requestId, estado, nota);
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

  return app;
}
