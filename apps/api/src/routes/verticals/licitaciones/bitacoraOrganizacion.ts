// L-P3-17 -- vista de la bitacora de ESCRITURAS de la organizacion (REQ-083/084/171), solo owner/admin (`STAFF_INVITE_ROLES`; ademas la RLS de
// `licitaciones.audit_trail`, migracion 038, solo deja leer a owner/admin: defensa en profundidad real, no solo esta capa).
//   GET /licitaciones/:propertyId/audit-trail?entity=&actorId=&desde=&hasta=&correlationId=&cursor=&limit=   (mas reciente primero, paginacion por llave)
//   GET /licitaciones/:propertyId/audit-trail/tenders/:tenderId/trace                                          (traza de una convocatoria, cronologica)
// Base sin la 038: `available: false` (estado honesto "no disponible aun"), nunca una lista vacia fingiendo "sin cambios" ni un 500.
// Los renglones son siempre de la organizacion del token (el filtro por organizacion va en SQL y en la RLS).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { AUDIT_DEFAULT_LIMIT, AUDIT_ENTITIES, AUDIT_MAX_LIMIT, STAFF_INVITE_ROLES, isAuditEntity, sanitizeCorrelationId } from "@atiende/domain-licitaciones";
import type { AuditTrailFilters } from "@atiende/domain-licitaciones";
import { runWithSavepointFallback } from "@atiende/db";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function licitacionesBitacoraOrganizacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const listPath = "/licitaciones/:propertyId/audit-trail";
  const tracePath = "/licitaciones/:propertyId/audit-trail/tenders/:tenderId/trace";
  for (const path of [listPath, tracePath]) app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  /** Nombres de quienes aparecen como actor (solo de la organizacion). Sin correos. Si la lectura falla se omite (nunca tumba la vista). */
  async function actores(c: import("hono").Context<CoreAuthHonoEnv>, ids: readonly (string | null)[]): Promise<Record<string, string>> {
    const set = new Set(ids.filter((x): x is string => x !== null));
    if (set.size === 0) return {};
    const db = c.get("db");
    return runWithSavepointFallback<Record<string, string>>({
      session: db,
      savepointName: "sp_licitaciones_audit_actores",
      primary: async () => {
        const out: Record<string, string> = {};
        for (const m of await deps.coreStaffRepo(db).listOrgMembers(c.get("organizationId"))) if (set.has(m.userId)) out[m.userId] = m.fullName;
        return out;
      },
      isRecoverable: () => true,
      fallback: async () => ({}),
    });
  }

  app.get(listPath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const q = c.req.query();
    if (q.entity !== undefined && q.entity !== "" && !isAuditEntity(q.entity)) throw Errors.validation(`entity: se esperaba ${AUDIT_ENTITIES.join(" | ")}.`);
    if (q.actorId !== undefined && q.actorId !== "" && !UUID_RE.test(q.actorId)) throw Errors.validation("actorId: se esperaba un UUID.");
    if (q.correlationId !== undefined && q.correlationId !== "" && sanitizeCorrelationId(q.correlationId) === null) throw Errors.validation("correlationId: 1 a 64 caracteres [A-Za-z0-9._:-].");
    const fecha = (name: "desde" | "hasta"): string | undefined => {
      const raw = q[name];
      if (raw === undefined || raw === "") return undefined;
      if (Number.isNaN(Date.parse(raw))) throw Errors.validation(`${name}: fecha invalida (ISO 8601).`);
      return new Date(raw).toISOString();
    };
    let limit = AUDIT_DEFAULT_LIMIT;
    if (q.limit !== undefined && q.limit !== "") {
      const n = Number(q.limit);
      if (!Number.isInteger(n) || n < 1 || n > AUDIT_MAX_LIMIT) throw Errors.validation(`limit: se esperaba un entero entre 1 y ${AUDIT_MAX_LIMIT}.`);
      limit = n;
    }
    if (q.cursor !== undefined && q.cursor !== "" && !/^\d{1,18}$/.test(q.cursor)) throw Errors.validation("cursor invalido.");
    const filters: AuditTrailFilters = {
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.correlationId ? { correlationId: q.correlationId } : {}),
      ...(fecha("desde") ? { desde: fecha("desde")! } : {}),
      ...(fecha("hasta") ? { hasta: fecha("hasta")! } : {}),
    };
    const repo = deps.licitacionesRepo(c.get("db"));
    const page = await repo.listAuditoria(c.get("organizationId"), filters, { limit, cursor: q.cursor || null });
    return c.json({ ...page, entities: AUDIT_ENTITIES, people: await actores(c, page.items.map((i) => i.actorId)) });
  });

  app.get(tracePath, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const tenderId = c.req.param("tenderId") ?? "";
    if (!UUID_RE.test(tenderId)) throw Errors.notFound("Convocatoria no encontrada.");
    const repo = deps.licitacionesRepo(c.get("db"));
    if (!(await repo.findTender(organizationId, tenderId))) throw Errors.notFound("Convocatoria no encontrada.");
    const q = c.req.query();
    if (q.cursor !== undefined && q.cursor !== "" && !/^\d{1,18}$/.test(q.cursor)) throw Errors.validation("cursor invalido.");
    const page = await repo.listAuditoria(organizationId, { tenderId }, { limit: AUDIT_MAX_LIMIT, cursor: q.cursor || null, orden: "asc" });
    return c.json({ ...page, people: await actores(c, page.items.map((i) => i.actorId)) });
  });

  return app;
}
