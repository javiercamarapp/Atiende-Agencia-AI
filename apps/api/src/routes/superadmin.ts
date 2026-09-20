// Back office de plataforma — cruzado a las 6 verticales, distinto de
// `core.membership.platform_role` (ese es DENTRO de una sola organización).
// Alcance de ESTE pase: solo lectura (listar organizaciones + conteo de staff
// por organización) — ninguna acción de escritura (suspender/reactivar una
// organización, dar de alta otro superadmin) todavía; eso queda para una
// siguiente pasada cuando exista un caso de uso real que lo pida.
//
// Autorización real: `deps.coreRepo.isPlatformSuperadmin`/las funciones SQL
// que consume (`core.list_all_organizations_for_superadmin`/
// `core.count_staff_by_organization_for_superadmin`) YA verifican por dentro
// que el caller es superadmin — el chequeo de aquí (`requireSuperadmin`) es
// defensa en profundidad (responde 403 explícito en vez de simplemente "0
// resultados", mejor UX de error), nunca la única autoridad real.
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { ProspectoNotFoundError } from "@atiende/db";
import type { AuthzAuditLogRow, ProspectoRow } from "@atiende/db";
import {
  ImpersonationWriteBlockedError,
  InMemoryRateLimiter,
  blockWritesWhileImpersonating,
  requireAdminAccess,
} from "@atiende/core-authz";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";

// Rate-limiter por-proceso, compartido por TODA la superficie `/superadmin/*`
// de la app compuesta (ver comentario largo más abajo sobre por qué el
// middleware montado AQUÍ gatea también las rutas de otros archivos). 30
// intentos denegados / 5 min por actor+ruta antes de 429, igual criterio que
// el resto del back office que ya usaba este patrón (ver commit de
// superadmin-impersonacion.ts).
//
// El AUDIT SINK ya NO es un `export const` module-level (a diferencia de
// antes de esta revisión) -- ahora es `deps.authzAuditSink` (ver deps.ts),
// para que producción pueda usar el sink PERSISTENTE
// (`PersistentAuthzAuditSink`, ver packages/db/migrations/
// 0021_superadmin_authz_audit_log.sql) y los tests sigan usando un
// `InMemoryAuditSink` liso -- ambos implementan el mismo
// `@atiende/core-authz::AuditSink`, `requireAdminAccess` no distingue cuál le
// tocó. Las pruebas que antes importaban `superadminAdminAccessAudit`
// directamente ahora leen `base.deps.authzAuditSink` (casteado a
// `InMemoryAuditSink`), mismo criterio que `base.deps.coreRepo as
// InMemoryCoreRepository` en el resto de este monorepo.
const superadminAdminAccessRateLimiter = new InMemoryRateLimiter({ capacity: 30, refillPerSecond: 30 / 300 });

// Único endpoint mutante que el requisito "solo lectura por defecto" permite
// EXPLÍCITAMENTE mientras hay una impersonación activa: terminar la propia
// sesión (ver write-guard.ts::exemptPathPatterns). `:id` es un uuid real en
// producción -- el patrón no valida su forma, solo su POSICIÓN, mismo
// criterio "fail-closed, sin matching laxo de más" que el resto del guard.
const IMPERSONACION_TERMINAR_PATH_RE = /^\/superadmin\/impersonacion\/sesiones\/[^/]+\/terminar$/;

const VERTICALES_VALIDAS = new Set(["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"]);
const ESTADOS_VALIDOS = new Set(["nuevo", "contactado", "demo", "propuesta", "negociacion", "ganado", "perdido", "descartado"]);

function serializeProspecto(p: ProspectoRow) {
  return {
    id: p.id,
    empresa: p.empresa,
    vertical: p.vertical,
    ciudad: p.ciudad,
    contactoNombre: p.contactoNombre,
    telefono: p.telefono,
    correo: p.correo,
    estado: p.estado,
    fuente: p.fuente,
    notas: p.notas,
    creadoPor: p.creadoPor,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** `string | null` desde JSON -- nunca `undefined` (el campo puede venir ausente,
 *  vacío, o con un valor real; los tres casos deben mapear a `null` limpio para
 *  las funciones SQL, que hacen `coalesce`/insertan `null`, nunca reciben
 *  `undefined`). */
function textoOpcional(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function serializeAuthzAuditLogEntry(e: AuthzAuditLogRow) {
  return {
    id: e.id,
    actorUserId: e.actorUserId,
    actorIp: e.actorIp,
    organizationId: e.organizationId,
    action: e.action,
    route: e.route,
    method: e.method,
    decision: e.decision,
    reason: e.reason,
    metadata: e.metadata,
    occurredAtMs: e.occurredAtMs,
  };
}

// Validación de `?limit=`/`?offset=` de `GET /superadmin/authz-auditoria` --
// mismo patrón (regex de entero sin signo COMPLETO, nunca `Number(...)` a
// secas) ya establecido y revisado en
// routes/superadmin-break-glass.ts::parseLimitQuery/parseOffsetQuery (hallazgo
// real de revisión, ronda r5, PR #167: `Number("1.5")`/`Number("1e2")` son
// enteros "válidos" para `Number.isFinite` sin serlo como TEXTO, y un
// `offset` sin tope superior desborda el `integer` de Postgres con SQLSTATE
// 22003/22P02 -- 500 genérico en ambos casos sin esta validación).
const AUTHZ_AUDIT_LOG_LIMIT_DEFAULT = 50;
const AUTHZ_AUDIT_LOG_LIMIT_MAX = 200;
const NONNEGATIVE_INT_RE = /^\d+$/;
const POSTGRES_INT32_MAX = 2147483647;

function parseAuthzAuditLimitQuery(raw: string | undefined): number {
  if (raw === undefined || raw === "") return AUTHZ_AUDIT_LOG_LIMIT_DEFAULT;
  if (!NONNEGATIVE_INT_RE.test(raw) || Number(raw) < 1) throw Errors.validation("limit debe ser un entero >= 1.");
  return Math.min(AUTHZ_AUDIT_LOG_LIMIT_MAX, Number(raw));
}

function parseAuthzAuditOffsetQuery(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  if (!NONNEGATIVE_INT_RE.test(raw)) throw Errors.validation("offset debe ser un entero >= 0.");
  const value = Number(raw);
  if (value > POSTGRES_INT32_MAX) throw Errors.validation(`offset debe ser menor o igual a ${POSTGRES_INT32_MAX}.`);
  return value;
}

interface CreateProspectoBody {
  readonly empresa?: unknown;
  readonly vertical?: unknown;
  readonly ciudad?: unknown;
  readonly contactoNombre?: unknown;
  readonly telefono?: unknown;
  readonly correo?: unknown;
  readonly fuente?: unknown;
  readonly notas?: unknown;
}

interface UpdateProspectoBody {
  readonly estado?: unknown;
  readonly notas?: unknown;
}

export function superadminRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // IMPORTANTE (hallazgo real durante esta tarea, no teórico -- verificado con
  // un test): Hono trata `app.use("/superadmin/*", mw)` como un patrón que
  // matchea CUALQUIER ruta bajo `/superadmin/` en la app COMPUESTA final --
  // no solo las que define ESTE archivo. `/superadmin/break-glass/*`,
  // `/superadmin/facturacion/*`, `/superadmin/impersonacion/*`, etc. viven en
  // sus PROPIOS Hono sub-apps (otros archivos), montados aparte en
  // `app.ts` -- pero igual comparten el prefijo `/superadmin/`, y
  // `apps/api/src/app.ts` monta ESTE router (`superadminRoutes`) ANTES que
  // todos los demás `superadmin-*.ts`. El efecto neto (demostrado con un test
  // de integración en `apps/api/src/app.ts`/`superadmin.spec.ts`): TODO
  // middleware montado aquí sobre `/superadmin/*` corre PRIMERO para
  // CUALQUIER request bajo ese prefijo, sin importar en qué archivo esté
  // definida la ruta final -- de ahí que la autenticación, el gateo de
  // admin-middleware y el write-guard de solo-lectura se monten los TRES
  // exactamente aquí, una sola vez, en vez de repetidos (e inevitablemente
  // incompletos) en cada `superadmin-*.ts` por separado.
  //
  // Corrección de esta revisión (bloqueante de seguridad, ver PR): antes de
  // este cambio, el guard de "solo lectura mientras impersonas" se montaba
  // como una ALLOWLIST de 3 rutas exactas -- cualquier ruta mutante nueva
  // (`/superadmin/acciones/*`, `/superadmin/gasto-api/*`,
  // `/superadmin/break-glass/*`, `/superadmin/facturacion/*`, la propia
  // `/superadmin/impersonacion/sesiones`) quedaba SIN GUARD por default. Y el
  // 403 de "no eres superadmin" era un `throw` plano (sin auditoría ni
  // rate-limit), lo que hacía INALCANZABLE la rama de denegación de
  // `requireAdminAccess` (audit-on-denial + rate-limit reales) que
  // `superadmin-impersonacion.ts` montaba en su propio archivo -- montada
  // DESPUÉS de este archivo en `app.ts`, esa rama nunca llegaba a ejecutarse
  // porque este 403 plano ya había cortado la cadena antes. Ambas piezas se
  // arreglan reemplazando el chequeo plano por `requireAdminAccess` (montado
  // AQUÍ, cubre TODA la superficie por el efecto de arriba) y el guard por
  // un DENYLIST fail-closed (bloquea todo método mutante bajo
  // `/superadmin/*`, con una excepción explícita por patrón: terminar la
  // propia sesión de impersonación).
  app.use("/superadmin/*", authMiddleware(deps.env));
  app.use("/superadmin/*", async (c, next) => {
    const isSuperadmin = await deps.coreRepo.isPlatformSuperadmin(c.get("userId"));
    // `platformRole` sintético -- MISMO criterio documentado en
    // `superadmin-impersonacion.ts`: un superadmin de plataforma no tiene
    // membership de organización, así que no hay un `PlatformRole` "real"
    // que leer aquí; se sintetiza "owner" para que `requireAdminAccess`
    // (que solo entiende `PlatformRole`) pueda gatear esta superficie
    // distinta con la MISMA pieza (audit-on-denial + rate-limit reales) que
    // el resto del back office de staff de organización.
    c.set("platformRole", isSuperadmin ? "owner" : undefined);
    await next();
  });
  app.use(
    "/superadmin/*",
    requireAdminAccess({
      allowedRoles: ["owner"],
      audit: deps.authzAuditSink,
      rateLimiter: superadminAdminAccessRateLimiter,
    }),
  );
  // Bloque C -- "por defecto SOLO LECTURA" mientras haya una sesión de
  // impersonación activa (ver packages/core-authz/src/impersonation/
  // write-guard.ts y 0020_superadmin_impersonacion.sql). Fail-closed: TODO
  // método mutante bajo `/superadmin/*` queda bloqueado mientras el caller
  // impersona, salvo `exemptPathPatterns` (terminar la propia sesión) --
  // nunca una lista de rutas protegidas que haya que recordar ampliar cada
  // vez que un archivo nuevo agregue un endpoint de escritura.
  const impersonationWriteGuard = blockWritesWhileImpersonating<CoreAuthHonoEnv>({
    isImpersonating: async (c) => {
      const callerId = c.get("userId");
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.impersonationRepo(db).getActiveSession(callerId));
      return result.availability === "available" && result.session !== null;
    },
    exemptPathPatterns: [IMPERSONACION_TERMINAR_PATH_RE],
  });
  // `ImpersonationWriteBlockedError` (core-authz) no es un `ApiError` (core-auth)
  // -- el `onError` global de apps/api/src/app.ts solo traduce `ApiError` a un
  // JSON con status real; sin este adaptador caería a 500 genérico. Mismo
  // criterio que el resto de `errors.ts`: cada error de negocio se traduce
  // explícitamente, nunca se deja caer al catch-all.
  const impersonationWriteGuardMiddleware = async (c: Context<CoreAuthHonoEnv>, next: Next) => {
    try {
      await impersonationWriteGuard(c, next);
    } catch (err) {
      if (err instanceof ImpersonationWriteBlockedError) throw Errors.forbidden(err.message);
      throw err;
    }
  };
  app.use("/superadmin/*", impersonationWriteGuardMiddleware);

  app.get("/superadmin/organizations", async (c) => {
    const callerId = c.get("userId");
    const [organizations, staffCounts] = await Promise.all([
      deps.coreRepo.listAllOrganizationsForSuperadmin(callerId),
      deps.coreRepo.countStaffByOrganizationForSuperadmin(callerId),
    ]);
    return c.json({
      organizations: organizations.map((o) => ({ ...o, staffCount: staffCounts.get(o.id) ?? 0 })),
    });
  });

  // "Cerebro de ventas" (ver supabase/migrations/20240101000114_0012_superadmin_
  // prospectos.sql) -- las 3 funciones SQL ya validan `is_platform_superadmin`
  // por dentro; el middleware de arriba es defensa en profundidad (403 explícito
  // en vez de una lista vacía/silenciosa).
  app.get("/superadmin/prospectos", async (c) => {
    const prospectos = await deps.coreRepo.listProspectosForSuperadmin(c.get("userId"));
    return c.json({ prospectos: prospectos.map(serializeProspecto) });
  });

  app.post("/superadmin/prospectos", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as CreateProspectoBody;
    if (typeof raw.empresa !== "string" || raw.empresa.trim().length === 0) throw Errors.validation("empresa requerida");
    if (typeof raw.vertical !== "string" || !VERTICALES_VALIDAS.has(raw.vertical)) throw Errors.validation("vertical inválida o ausente");

    const prospecto = await deps.coreRepo.createProspectoForSuperadmin(c.get("userId"), {
      empresa: raw.empresa.trim(),
      vertical: raw.vertical,
      ciudad: textoOpcional(raw.ciudad),
      contactoNombre: textoOpcional(raw.contactoNombre),
      telefono: textoOpcional(raw.telefono),
      correo: textoOpcional(raw.correo),
      fuente: textoOpcional(raw.fuente),
      notas: textoOpcional(raw.notas),
    });
    return c.json({ prospecto: serializeProspecto(prospecto) }, 201);
  });

  app.patch("/superadmin/prospectos/:id", async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as UpdateProspectoBody;
    const estado = typeof raw.estado === "string" ? raw.estado : null;
    if (estado !== null && !ESTADOS_VALIDOS.has(estado)) throw Errors.validation("estado inválido");
    const notas = textoOpcional(raw.notas);

    try {
      const prospecto = await deps.coreRepo.updateProspectoForSuperadmin(c.get("userId"), c.req.param("id"), estado, notas);
      return c.json({ prospecto: serializeProspecto(prospecto) });
    } catch (err) {
      if (err instanceof ProspectoNotFoundError) throw Errors.notFound(err.message);
      throw err;
    }
  });

  // "Entrar a los otros paneles" (ver supabase/migrations/20240101000119_0014_
  // superadmin_demo_access.sql para el diseño completo): asegura una organización
  // DEMO real para `vertical` + membresía real del superadmin en ella (idempotente,
  // NUNCA toca datos de un cliente real). El frontend encadena la respuesta con el
  // POST /auth/select-org YA existente (mismo Bearer, misma sesión) para obtener un
  // token real del Shell de esa vertical -- esta ruta NUNCA emite un token por su
  // cuenta, solo prepara el terreno.
  app.post("/superadmin/paneles/:vertical/entrar", async (c) => {
    const vertical = c.req.param("vertical");
    if (!VERTICALES_VALIDAS.has(vertical)) throw Errors.validation("vertical inválida");
    const { organizationId, slug } = await deps.coreRepo.ensureDemoAccessForSuperadmin(c.get("userId"), vertical);
    return c.json({ organizationId, slug });
  });

  // Bitácora persistente de denegaciones de acceso a /superadmin/* (ver
  // packages/db/migrations/0021_superadmin_authz_audit_log.sql) -- oversight
  // de plataforma, junto a la de impersonación (routes/
  // superadmin-impersonacion.ts::GET .../impersonacion/bitacora). Paginado
  // real con `?limit=`/`?offset=` (a diferencia de la bitácora de
  // impersonación, que solo pagina por `limit`) -- `hasMore` viaja en la
  // respuesta para que el panel pueda ofrecer "cargar más" sin un COUNT(*)
  // aparte (ver PostgresAuthzAuditRepository.list). `available: false`
  // cuando la migración 0021 todavía no está aplicada -- nunca 500, nunca una
  // lista vacía indistinguible de "no hay denegaciones".
  app.get("/superadmin/authz-auditoria", async (c) => {
    const callerId = c.get("userId");
    const limit = parseAuthzAuditLimitQuery(c.req.query("limit"));
    const offset = parseAuthzAuditOffsetQuery(c.req.query("offset"));
    const { availability, entries, hasMore } = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.authzAuditRepo(db).list(callerId, limit, offset));
    return c.json({ available: availability === "available", entries: entries.map(serializeAuthzAuditLogEntry), hasMore });
  });

  return app;
}
