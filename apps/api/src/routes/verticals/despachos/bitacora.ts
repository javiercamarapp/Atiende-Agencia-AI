// D-38 -- bitacora de acceso del despacho (lecturas, descargas y exportaciones, ademas de las escrituras ya auditadas).
//
//  GET /v1/despachos/:orgSlug/admin/bitacora?limit=&offset=
//
// Elegido un endpoint GET paginado (no una pagina de reporte existente: el panel de despachos no tiene hoy ninguna pantalla de
// bitacora). Solo `VER_BITACORA_ROLES` (admin y auditor) y solo con membresia de TODA la organizacion (`propertyIds === null`):
// la bitacora es de nivel organizacion y un staff acotado a ciertos clientes veria filas de los demas.
//
// Que devuelve por fila: id, fecha, actor (id de usuario, nunca correo), accion, ruta, metodo, decision, tipo de evento, recurso y
// `detalle` (solo valores escalares del metadata: identificadores y parametros de forma). Nunca ip, user-agent ni contenido.
//
// Orden: mas reciente primero con desempate total (`listAuditLogPage`, migracion 011; contra una base sin ella degrada solo
// a `created_at desc` dentro de un SAVEPOINT). `despachos.audit_log` existe desde la migracion 008, ya aplicada en la base real.
import { Hono } from "hono";
import { authMiddleware, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { VER_BITACORA_ROLES } from "@atiende/domain-despachos";
import type { DespachosAuditLogEntry } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { TIPOS_EVENTO_ACCESO } from "./auditoria-acceso.ts";
import type { TipoEventoAcceso } from "./auditoria-acceso.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type Escalar = string | number | boolean | null;

function esEscalar(v: unknown): v is Escalar {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function texto(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function esTipo(v: unknown): v is TipoEventoAcceso {
  return typeof v === "string" && (TIPOS_EVENTO_ACCESO as readonly string[]).includes(v);
}

/** Proyeccion segura de una fila de `despachos.audit_log`: solo campos conocidos y valores escalares. */
export function serializarEntradaBitacora(e: DespachosAuditLogEntry) {
  const payload = e.payload ?? {};
  const metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata) ? (payload.metadata as Record<string, unknown>) : {};
  const detalle: Record<string, Escalar> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (k === "tipoEvento" || k === "recurso") continue;
    if (esEscalar(v)) detalle[k] = v;
  }
  return {
    id: e.id,
    fecha: e.createdAt,
    actorUserId: e.actorUserId,
    accion: e.action,
    ruta: texto(payload.route),
    metodo: texto(payload.method),
    decision: texto(payload.decision),
    tipoEvento: esTipo(metadata.tipoEvento) ? metadata.tipoEvento : null,
    recurso: texto(metadata.recurso),
    detalle,
  };
}

function entero(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

export function despachosBitacoraRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/despachos/:orgSlug/admin/bitacora", authMiddleware(deps.env), dbSession(deps.engine));

  app.get("/v1/despachos/:orgSlug/admin/bitacora", async (c) => {
    const repo = deps.despachosRepo(c.get("db"));
    const org = await repo.findOrganizationBySlug(c.req.param("orgSlug"));
    if (!org || !org.isActive) throw Errors.notFound(`Negocio "${c.req.param("orgSlug")}" no encontrado o inactivo.`);
    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    const membership = memberships.find((m) => m.organizationId === org.id);
    if (!membership) throw Errors.forbidden("No perteneces a esta organización.");
    if (!(VER_BITACORA_ROLES as readonly string[]).includes(membership.verticalRole ?? "")) throw Errors.forbidden(`Tu rol (${membership.verticalRole}) no puede ver la bitácora.`);
    if (membership.propertyIds !== null) throw Errors.forbidden("La bitácora requiere acceso a toda la organización.");

    const limit = entero(c.req.query("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = entero(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

    const page = await repo.listAuditLogPage(org.id, { limit, offset });
    c.header("Cache-Control", "private, no-store");
    return c.json({ eventos: page.items.map(serializarEntradaBitacora), total: page.total, nextOffset: page.nextOffset });
  });

  return app;
}
