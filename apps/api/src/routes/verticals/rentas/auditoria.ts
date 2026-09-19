// r5 -- GET /v1/rentas/:orgSlug/admin/auditoria: bitácora paginada de acciones
// sensibles del staff (cambios de precio/tarifa, cancelación/modificación de
// reservas, payouts, ajustes de owner statement, conexión/desconexión de canales
// iCal) -- ver packages/domain-rentas/migrations/021_rentas_audit_log.sql para el
// mecanismo de escritura (rentas.record_audit_log, security definer, actor SIEMPRE
// de auth.uid()).
//
// Solo owner/admin (`admin_gestora`) de la organización -- mismo rol que
// PRICING_ESCRITURA_ROLES/FINANZAS_ESCRITURA_ROLES (ambos = admin_gestora
// únicamente, ver packages/domain-rentas/src/roles.ts): la bitácora expone qué hizo
// CADA miembro del staff, información que un compañero sin rol de administración no
// necesita ver. La RLS de `rentas.audit_log` (policy de SELECT) ya lo exige como
// defensa en profundidad -- este check explícito da un 403 claro en vez de dejar que
// RLS filtre en silencio a una lista vacía indistinguible de "sin resultados".
//
// Sin `requirePropertyMembership` (no hay propertyId en el path -- la bitácora es de
// TODA la organización, nunca de una sola property): mismo patrón que
// admin-discovery.ts -- resuelve `orgSlug` -> organizationId y verifica
// membership+rol A MANO, vía `deps.coreRepo.findMembershipsByUserId`.
import { Hono } from "hono";
import { authMiddleware, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { RentasAuditEntityType } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const ENTITY_TYPES: readonly RentasAuditEntityType[] = ["pricing", "reserva", "payout", "owner_statement", "membership", "canal"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseEntityType(raw: string | undefined): RentasAuditEntityType | null {
  if (!raw) return null;
  if (!(ENTITY_TYPES as readonly string[]).includes(raw)) {
    throw Errors.validation(`tipo: se esperaba uno de ${ENTITY_TYPES.join(", ")}.`);
  }
  return raw as RentasAuditEntityType;
}

function parseFecha(raw: string | undefined, field: string): string | null {
  if (!raw) return null;
  if (!DATE_RE.test(raw)) throw Errors.validation(`${field}: formato de fecha esperado YYYY-MM-DD.`);
  return raw;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) throw Errors.validation("limit: se esperaba un entero >= 1.");
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) throw Errors.validation("offset: se esperaba un entero >= 0.");
  return n;
}

export function rentasAuditoriaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const path = "/v1/rentas/:orgSlug/admin/auditoria";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine));

  app.get(path, async (c) => {
    const orgSlug = c.req.param("orgSlug");
    const repo = deps.rentasRepo(c.get("db"));
    const org = await repo.findOrganizationBySlug(orgSlug);
    if (!org) throw Errors.notFound(`Organización de rentas "${orgSlug}" no encontrada.`);

    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    const membership = memberships.find((m) => m.organizationId === org.id);
    if (!membership || membership.verticalRole !== "admin_gestora") {
      throw Errors.forbidden("Solo un administrador de la organización puede leer la bitácora de auditoría.");
    }

    const tipo = parseEntityType(c.req.query("tipo"));
    const desde = parseFecha(c.req.query("desde"), "desde");
    const hasta = parseFecha(c.req.query("hasta"), "hasta");
    const limit = parseLimit(c.req.query("limit"));
    const offset = parseOffset(c.req.query("offset"));

    const pagina = await repo.listAuditoria(org.id, { entityType: tipo, desde, hasta }, { limit, offset });

    return c.json(
      {
        disponible: pagina.disponible,
        total: pagina.total,
        nextOffset: pagina.nextOffset,
        items: pagina.items.map((r) => ({
          id: r.id,
          actorUserId: r.actorUserId,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          campo: r.campo,
          antes: r.antes,
          despues: r.despues,
          creadoEn: new Date(r.createdAtMs).toISOString(),
        })),
      },
      200,
    );
  });

  return app;
}
