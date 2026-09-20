// FASE 3 (producto) — GET /v1/restaurantes/:propertyId/admin/auditoria: bitácora
// paginada de acciones sensibles del staff (cambios de precio/disponibilidad de
// productos, promociones, cancelación de pedidos, asignación de repartidor,
// invitación/baja/cambio de rol de staff) -- ver packages/domain-restaurantes/
// migrations/019_restaurantes_audit_log.sql para el mecanismo de escritura
// (restaurantes.record_audit_log, security definer, actor SIEMPRE de auth.uid(),
// validado además contra MANAGER_ROLES dentro de la propia función SQL).
//
// Solo owner/admin de la organización (mandato explícito de esta fase, MÁS
// estricto que rentas.audit_log -- ver el comentario de cabecera de esa
// migración): restaurantes SÍ tiene un rol "staff" de gestión (MANAGER_ROLES
// incluye "staff") que puede escribir en la bitácora (cambiar un precio,
// cancelar un pedido) pero NO debe poder leer qué hizo cada compañero. La RLS de
// `restaurantes.audit_log` (policy de SELECT) ya lo exige como defensa en
// profundidad -- este check explícito da un 403 claro en vez de dejar que RLS
// filtre en silencio a una lista vacía indistinguible de "sin resultados".
//
// Montada sobre `:propertyId` con `requirePropertyMembership` (mismo patrón que
// el resto de rutas admin de restaurantes, ver admin-kpis.ts) -- la bitácora es
// de TODA la organización (mismo criterio que rentas, ver el comentario de
// cabecera de la migración), `:propertyId` en el path solo sirve para resolver
// `organizationId` real vía la membership verificada.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { RestaurantesAuditEntityType, RestaurantesRole } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const ENTITY_TYPES: readonly RestaurantesAuditEntityType[] = ["producto", "promocion", "pedido", "repartidor", "staff", "configuracion"];
// Solo owner/admin (mandato explícito de esta fase) -- deliberadamente MÁS
// angosto que `MANAGER_ROLES` (owner/admin/staff, que sí puede ESCRIBIR en la
// bitácora vía las rutas de arriba, pero no LEERLA).
const AUDITORIA_LECTURA_ROLES: readonly RestaurantesRole[] = ["owner", "admin"];
// Grupos de captura (corrección de revisión sobre el PR #183, no bloqueante #4):
// el regex de forma NO basta -- "2026-13-45" tiene la forma YYYY-MM-DD pero no es
// una fecha real, y llegaba tal cual al `::timestamptz` de
// `PostgresRestaurantesRepository.listAuditoria` (SQLSTATE 22008, invalid_datetime_
// format -- NO es uno de los 3 códigos de "base sin migrar" que
// `runWithSavepointFallback` sabe recuperar), terminando en 500 en vez de 400.
// `parseFecha` ahora valida el CALENDARIO real (rechaza mes/día fuera de rango,
// incluido el 29 de febrero en año no bisiesto) antes de que la fecha llegue a
// Postgres.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Solo dígitos -- a diferencia de `Number.parseInt`, que acepta un prefijo
// numérico y descarta silenciosamente el resto ("12abc" -> 12).
const ENTERO_RE = /^\d+$/;

function parseEntityType(raw: string | undefined): RestaurantesAuditEntityType | null {
  if (!raw) return null;
  if (!(ENTITY_TYPES as readonly string[]).includes(raw)) {
    throw Errors.validation(`tipo: se esperaba uno de ${ENTITY_TYPES.join(", ")}.`);
  }
  return raw as RestaurantesAuditEntityType;
}

function parseFecha(raw: string | undefined, field: string): string | null {
  if (!raw) return null;
  const m = DATE_RE.exec(raw);
  if (!m) throw Errors.validation(`${field}: formato de fecha esperado YYYY-MM-DD.`);
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  // Redondeo UTC para no depender de la zona horaria del proceso -- solo importan
  // los 3 componentes, nunca una hora real.
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
    throw Errors.validation(`${field}: "${raw}" no es una fecha de calendario válida.`);
  }
  return raw;
}

function parseEntero(raw: string, field: string): number {
  if (!ENTERO_RE.test(raw)) throw Errors.validation(`${field}: se esperaba un entero.`);
  return Number.parseInt(raw, 10);
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = parseEntero(raw, "limit");
  if (n < 1) throw Errors.validation("limit: se esperaba un entero >= 1.");
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  return parseEntero(raw, "offset");
}

export function restaurantesAuditoriaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const path = "/v1/restaurantes/:propertyId/admin/auditoria";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    // `assertVerticalRole` (core-auth) ya da el 403 con el mensaje estándar del
    // resto del repo cuando el rol no alcanza -- mismo criterio que el resto de
    // rutas admin de restaurantes, en vez de reimplementar el mensaje a mano.
    assertVerticalRole(c, AUDITORIA_LECTURA_ROLES);

    const repo = deps.restaurantesRepo(c.get("db"));
    const organizationId = c.get("organizationId");

    const tipo = parseEntityType(c.req.query("tipo"));
    const desde = parseFecha(c.req.query("desde"), "desde");
    const hasta = parseFecha(c.req.query("hasta"), "hasta");
    const limit = parseLimit(c.req.query("limit"));
    const offset = parseOffset(c.req.query("offset"));

    const pagina = await repo.listAuditoria(organizationId, { entityType: tipo, desde, hasta }, { limit, offset });

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
