// "Romper cristal" (break-glass) de plataforma -- Fase 10b, cierra el gap señalado
// por la auditoría del 18-sep-2026 ("break-glass de superadmin construido pero
// desconectado de toda ruta HTTP", ver packages/domain-rentas/src/break-glass/*.ts
// y packages/domain-rentas/migrations/012_break_glass_audit.sql/
// 018_break_glass_wiring.sql).
//
// Mismo patrón EXACTO que superadmin.ts/superadmin-llm-usage.ts: `authMiddleware` +
// `requireSuperadmin` (defensa en profundidad, 403 explícito) -- la autoridad REAL
// vive en las funciones `security definer` que `apps/api` invoca SIEMPRE sobre la
// sesión del propio superadmin (`engine.withAppSession({ userId: callerId })`,
// PATRÓN del PR #127/`core-repository.ts`, NUNCA sesión de sistema). Además, las
// lecturas de datos de tenant exigen una `rentas.break_glass_session` VIGENTE (sin
// cerrar, sin vencer) para el mismo actor+organización -- verificado dos veces:
// aquí (para un 403 con mensaje claro, ver `obtenerAccesoActivoBreakGlass`) y
// DENTRO de `rentas.list_reservas_for_break_glass` (defensa en profundidad real,
// nunca confiada solo de esta capa).
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  BREAK_GLASS_LECTOR_LIMIT_DEFAULT,
  BREAK_GLASS_LECTOR_LIMIT_MAX,
  BreakGlassAccessDeniedError,
  BreakGlassDurationInvalidError,
  BreakGlassOrganizationRequiredError,
  BreakGlassPropertyNotFoundError,
  BreakGlassReasonRequiredError,
  BreakGlassSessionNotFoundError,
  abrirAccesoBreakGlass,
  cerrarAccesoBreakGlass,
  esSesionBreakGlassActiva,
  leerFinanzasTenantBreakGlass,
  leerLimpiezaTenantBreakGlass,
  leerMensajeriaTenantBreakGlass,
  leerPayoutsTenantBreakGlass,
  leerPricingTenantBreakGlass,
  leerReservasTenantBreakGlass,
  leerSyncIcalTenantBreakGlass,
  listarAccesosBreakGlass,
  obtenerAccesoActivoBreakGlass,
} from "@atiende/domain-rentas";
import type { BreakGlassAccessInput, BreakGlassAuditEntry, BreakGlassAuditRepository, BreakGlassLectorResultado, BreakGlassRentasDataRepository, BreakGlassSession } from "@atiende/domain-rentas";
import { rateLimit } from "@atiende/core-ratelimit";
import type { Context } from "hono";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import type { AppDeps } from "../deps.ts";

const BREAK_GLASS_RATE_LIMIT = { max: 20, windowMs: 5 * 60_000 } as const;

interface AbrirAccesoBody {
  readonly organizationId?: unknown;
  readonly reason?: unknown;
  readonly durationMinutes?: unknown;
}

// Hallazgo de revisión real (ronda r5): `?propertyId=`/`?limit=`/`?offset=` de
// las 7 rutas de lectura de tenant (`registrarLectorTenant`, abajo) llegaban
// SIN VALIDAR hasta las funciones `security definer` de Postgres --
// `propertyId` sin forma de UUID producía SQLSTATE 22P02
// (invalid_text_representation, mismo caso que
// `superadmin-facturacion.ts::parseOrganizationIdQuery` ya documenta) y un
// `limit`/`offset` no-entero (`1.5`), negativo, o no-numérico llegaba tal
// cual como parámetro `integer` de Postgres -- 500 genérico en los tres
// casos. Validar aquí (400 explícito, nunca toca la base) es el mismo
// criterio que el resto de este monorepo aplica a cualquier id/paginado que
// entra por query string.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePropertyIdQuery(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!UUID_REGEX.test(raw)) throw Errors.validation("propertyId debe ser un UUID válido.");
  return raw;
}

// Entero SIN SIGNO en texto completo (`^\d+$`) -- deliberadamente más estricto
// que `Number.isInteger(Number(raw))`: `Number("1.5")`/`Number(" 3")`/
// `Number("3e2")` son todos valores que `Number.isFinite` aceptaría sin
// pestañear, pero ninguno es "un entero escrito como un entero" -- el patrón
// de texto se exige PRIMERO, antes de convertir, para que ninguna de esas
// formas se cuele.
const NONNEGATIVE_INT_RE = /^\d+$/;

function parseLimitQuery(raw: string | undefined): number {
  if (raw === undefined || raw === "") return BREAK_GLASS_LECTOR_LIMIT_DEFAULT;
  if (!NONNEGATIVE_INT_RE.test(raw) || Number(raw) < 1) {
    throw Errors.validation("limit debe ser un entero >= 1.");
  }
  // Por encima del tope no es un error de validación (holgado a propósito,
  // mismo criterio que el resto de paginados de este monorepo) -- se acota en
  // silencio al máximo, nunca se rechaza una petición honesta de "tráeme
  // todo lo que puedas".
  return Math.min(BREAK_GLASS_LECTOR_LIMIT_MAX, Number(raw));
}

// Hallazgo de revisión real (ronda r5, no-bloqueante 1 del PR #167): `offset`
// no tenía tope superior -- `^\d+$` acepta `2147483648`, `3000000000` o un
// número de 400 dígitos (`Number(...)` da `Infinity`), y `p_offset` es
// `integer` en las 7 funciones de `020_break_glass_lectores.sql` -- por
// encima de `2147483647` (el máximo de un `integer` de Postgres) Postgres
// lanza SQLSTATE `22003` (o `22P02` si `Number` desbordó a `Infinity`), el
// mismo 500 genérico que este PR existe para eliminar. A diferencia de
// `limit` (que se acota en silencio -- una petición honesta de "tráeme todo
// lo que puedas" nunca debe rechazarse), un `offset` mayor al máximo de
// Postgres no es una petición honesta de paginado: ningún dataset real tiene
// tantas filas, así que se rechaza explícito con 400.
const POSTGRES_INT32_MAX = 2147483647;

function parseOffsetQuery(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  if (!NONNEGATIVE_INT_RE.test(raw)) {
    throw Errors.validation("offset debe ser un entero >= 0.");
  }
  const value = Number(raw);
  if (value > POSTGRES_INT32_MAX) {
    throw Errors.validation(`offset debe ser menor o igual a ${POSTGRES_INT32_MAX}.`);
  }
  return value;
}

function serializeSession(s: BreakGlassSession, nowMs: number = Date.now()) {
  return {
    id: s.id,
    organizationId: s.organizationId,
    reason: s.reason,
    openedAtMs: s.openedAtMs,
    expiresAtMs: s.expiresAtMs,
    closedAtMs: s.closedAtMs,
    closedBy: s.closedBy,
    activa: esSesionBreakGlassActiva(s, nowMs),
    remainingMs: Math.max(0, s.expiresAtMs - nowMs),
  };
}

function serializeAuditEntry(e: BreakGlassAuditEntry) {
  return {
    id: e.id,
    organizationId: e.organizationId,
    reason: e.reason,
    resourceType: e.resourceType,
    resourceScope: e.resourceScope,
    resultSummary: e.resultSummary,
    occurredAtMs: e.occurredAtMs,
    seq: e.seq,
    hash: e.hash,
  };
}

export function superadminBreakGlassRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/break-glass/*", authMiddleware(deps.env));
  app.use("/superadmin/break-glass/*", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) {
      throw Errors.forbidden("El acceso de romper-cristal es exclusivo del back office de plataforma.");
    }
    await next();
  });
  // Rate-limit compartido por TODA la superficie de break-glass, categoría "admin"
  // de packages/core-ratelimit/src/endpoint-policy.ts (fail-closed -- "superficie
  // de operador con privilegios elevados"): abrir/cerrar/listar/leer cuentan contra
  // el MISMO presupuesto por superadmin -- un solo lugar, en vez de repetir la
  // llamada en cada handler.
  app.use("/superadmin/break-glass/*", async (c, next) => {
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:break-glass:${requestActor(c.req.raw, callerId)}`, BREAK_GLASS_RATE_LIMIT.max, BREAK_GLASS_RATE_LIMIT.windowMs, {
      category: "admin",
    });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas operaciones de romper-cristal en poco tiempo.");
    await next();
  });

  // Abrir un acceso de emergencia -- organización objetivo + motivo obligatorio +
  // duración acotada (5-240 minutos, ver BREAK_GLASS_MIN/MAX_DURATION_MINUTES).
  app.post("/superadmin/break-glass/sesiones", async (c) => {
    const callerId = c.get("userId");
    const raw = (await c.req.json().catch(() => ({}))) as AbrirAccesoBody;
    const organizationId = typeof raw.organizationId === "string" ? raw.organizationId.trim() : "";
    const reason = typeof raw.reason === "string" ? raw.reason : "";
    const durationMinutes = typeof raw.durationMinutes === "number" ? raw.durationMinutes : NaN;

    try {
      const session = await deps.engine.withAppSession({ userId: callerId }, (db) =>
        abrirAccesoBreakGlass(deps.rentasBreakGlassSessionRepo(db), {
          actor: { userId: callerId, email: c.get("userEmail") },
          organizationId,
          reason,
          durationMinutes,
        }),
      );
      return c.json({ session: serializeSession(session) }, 201);
    } catch (err) {
      if (err instanceof BreakGlassReasonRequiredError || err instanceof BreakGlassDurationInvalidError) throw Errors.validation(err.message);
      if (err instanceof BreakGlassOrganizationRequiredError) throw Errors.validation(err.message);
      throw err;
    }
  });

  // Listar accesos propios -- activos E históricos (nunca solo los vigentes: el
  // requisito explícito del gap).
  app.get("/superadmin/break-glass/sesiones", async (c) => {
    const callerId = c.get("userId");
    const sessions = await deps.engine.withAppSession({ userId: callerId }, (db) =>
      listarAccesosBreakGlass(deps.rentasBreakGlassSessionRepo(db), { userId: callerId, email: c.get("userEmail") }),
    );
    return c.json({ sessions: sessions.map((s) => serializeSession(s)) });
  });

  // Cerrar manualmente un acceso propio y todavía abierto.
  app.post("/superadmin/break-glass/sesiones/:id/cerrar", async (c) => {
    const callerId = c.get("userId");
    try {
      const session = await deps.engine.withAppSession({ userId: callerId }, (db) =>
        cerrarAccesoBreakGlass(deps.rentasBreakGlassSessionRepo(db), { userId: callerId, email: c.get("userEmail") }, c.req.param("id")),
      );
      return c.json({ session: serializeSession(session) });
    } catch (err) {
      if (err instanceof BreakGlassSessionNotFoundError) throw Errors.notFound(err.message);
      throw err;
    }
  });

  // Bitácora inmutable de lecturas propias (ver 012_break_glass_audit.sql) --
  // "vista de la bitácora" que pide la pantalla /superadmin/break-glass.
  app.get("/superadmin/break-glass/bitacora", async (c) => {
    const callerId = c.get("userId");
    const entries = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.rentasBreakGlassAuditRepo(db).listForActor(callerId));
    return c.json({ entries: entries.map(serializeAuditEntry) });
  });

  // Lectura de datos de tenant bajo break-glass -- 7 categorías de dato hoy
  // (`resourceType: "reservas"`, del PR #132, más las 6 que esta fase agrega:
  // `finanzas`/`payouts`/`pricing`/`mensajeria`/`limpieza`/`sync_ical`, ver
  // BreakGlass*Resumen en tipos.ts). Las 7 comparten el MISMO gate: SOLO mientras
  // haya un acceso activo y vigente del propio superadmin para esta organización
  // -- sin eso, 403 explícito ANTES de intentar la lectura (defensa en
  // profundidad: cada función SQL lo exige de nuevo, nunca confiada solo de este
  // chequeo TS). Cada lectura exitosa queda registrada en la bitácora inmutable
  // dentro de su composición `leer*TenantBreakGlass` (fail-closed: si el
  // registro de auditoría falla, los datos ya leídos NUNCA llegan al llamador).
  //
  // Filtro opcional por propiedad (`?propertyId=`) y paginado con tope
  // (`?limit=`/`?offset=`, tope duro `BREAK_GLASS_LECTOR_LIMIT_MAX`) -- mismo
  // contrato en las 7 rutas, `registrarLectorTenant` (abajo) evita repetir el
  // parseo de query params + manejo de errores 7 veces.
  registrarLectorTenant(app, deps, "reservas", "reservas", leerReservasTenantBreakGlass);
  registrarLectorTenant(app, deps, "finanzas", "finanzas", leerFinanzasTenantBreakGlass);
  registrarLectorTenant(app, deps, "payouts", "payouts", leerPayoutsTenantBreakGlass);
  registrarLectorTenant(app, deps, "pricing", "pricing", leerPricingTenantBreakGlass);
  registrarLectorTenant(app, deps, "mensajeria", "mensajeria", leerMensajeriaTenantBreakGlass);
  registrarLectorTenant(app, deps, "limpieza", "limpieza", leerLimpiezaTenantBreakGlass);
  registrarLectorTenant(app, deps, "sync-ical", "syncIcal", leerSyncIcalTenantBreakGlass);

  return app;
}

/**
 * Registra `GET /superadmin/break-glass/organizaciones/:organizationId/<path>`
 * para UNA composición `leer*TenantBreakGlass` -- las 7 rutas de lectura de
 * tenant de arriba comparten exactamente esta forma (mismo gate de sesión
 * vigente, mismo parseo de `?propertyId=`/`?limit=`/`?offset=`/`?reason=`, mismo
 * manejo de `BreakGlassReasonRequiredError` -> 422), solo cambia el segmento de
 * URL, la clave del JSON de respuesta, y qué composición de dominio invocar.
 *
 * FIX hallazgo de revisión real (ronda 1 del PR #155, bloqueante 3) --
 * `disponible` viaja SIEMPRE en la respuesta (`true` para reservas, que nunca
 * tiene un estado "no disponible" genuino, o el valor real del wrapper para
 * los otros 6) para que la pestaña web distinga "el tenant no tiene datos de
 * este tipo" de "el lector todavía no está disponible". `auditEntry` puede
 * llegar `null` cuando el lector no estaba disponible (acceso.ts NUNCA audita
 * una lectura que no ocurrió) -- no se expone en el JSON (la bitácora ya tiene
 * su propio endpoint), pero es la razón por la que el tipo de `leer` lo
 * permite.
 *
 * `hasMore` (hallazgo BAJA de la auditoría a2) también viaja SIEMPRE --
 * `data` es `BreakGlassLectorResultado<T>` en LOS 7 lectores desde que se
 * unificó el contrato de `listReservasTenant` (ver
 * packages/domain-rentas/src/break-glass/data-repository.ts), así que ya no
 * hace falta el `Array.isArray` que esta función tenía que resolver antes de
 * esa unificación.
 */
function registrarLectorTenant<T>(
  app: Hono<CoreAuthHonoEnv>,
  deps: AppDeps,
  path: string,
  jsonKey: string,
  leer: (
    auditRepo: BreakGlassAuditRepository,
    dataRepo: BreakGlassRentasDataRepository,
    input: Omit<BreakGlassAccessInput, "resourceType">,
    nowMs?: number,
  ) => Promise<{ data: BreakGlassLectorResultado<T>; auditEntry: BreakGlassAuditEntry | null }>,
): void {
  app.get(`/superadmin/break-glass/organizaciones/:organizationId/${path}`, async (c: Context<CoreAuthHonoEnv>) => {
    const callerId = c.get("userId");
    // `c.req.param("organizationId")` -- la ruta se arma con un template literal
    // (el path varía por lector), así que Hono ya no puede inferir en tiempo de
    // compilación que ":organizationId" existe en ESTA cadena concreta (a
    // diferencia de una ruta literal, ver el resto de handlers de este archivo) --
    // el tipo resultante es `string | undefined`, aunque en tiempo de ejecución
    // Hono garantiza que viene poblado porque el segmento SÍ está en el patrón
    // registrado. `?? ""` solo satisface al compilador; una cadena vacía nunca
    // matchea ningún `core.organization.id` real, así que el peor caso honesto es
    // "organización no encontrada" más abajo, nunca un comportamiento distinto.
    const organizationId = c.req.param("organizationId") ?? "";
    const reason = c.req.query("reason") ?? "";
    // Las 3 líneas de abajo lanzan 400 (Errors.validation) ANTES de abrir
    // `withAppSession` -- un `propertyId`/`limit`/`offset` inválido nunca
    // toca la base. Ver el comentario de cabecera de estas funciones para el
    // hallazgo real que corrigen.
    const propertyId = parsePropertyIdQuery(c.req.query("propertyId"));
    const limit = parseLimitQuery(c.req.query("limit"));
    const offset = parseOffsetQuery(c.req.query("offset"));

    return deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const actor = { userId: callerId, email: c.get("userEmail") };
      const sesionActiva = await obtenerAccesoActivoBreakGlass(deps.rentasBreakGlassSessionRepo(db), callerId, organizationId);
      if (!sesionActiva) {
        throw Errors.forbidden("Sin acceso de romper-cristal activo y vigente para esta organización -- abre uno antes de leer datos del tenant.");
      }

      try {
        const { data } = await leer(deps.rentasBreakGlassAuditRepo(db), deps.rentasBreakGlassDataRepo(db), {
          actor,
          organizationId,
          reason: reason || sesionActiva.reason,
          resourceScope: { propertyId, limit, offset },
        });
        return c.json({ [jsonKey]: data.datos, disponible: data.disponible, hasMore: data.hasMore });
      } catch (err) {
        if (err instanceof BreakGlassReasonRequiredError) throw Errors.validation(err.message);
        // Defensa en profundidad real de Postgres (ver el comentario de
        // cabecera de `BreakGlassPropertyNotFoundError`/`BreakGlassAccessDeniedError`
        // en errors.ts) -- `PostgresBreakGlassRentasDataRepository` ya dejó la
        // transacción recuperada (ROLLBACK TO SAVEPOINT) antes de lanzar
        // cualquiera de estos dos, así que mapear aquí y devolver es seguro:
        // no se vuelve a tocar `db` después de este punto.
        if (err instanceof BreakGlassPropertyNotFoundError) throw Errors.notFound(err.message);
        if (err instanceof BreakGlassAccessDeniedError) throw Errors.forbidden(err.message);
        throw err;
      }
    });
  });
}
