// FASE 3 (producto) — ZONA HORARIA POR NEGOCIO, parte hoteles (2 de 4 -- las otras 3
// partes cubren citas+rentas, despachos+restaurantes, y licitaciones). Hasta esta
// migración `hoteles.*` no tenía NINGUNA columna de zona horaria por property --
// night-audit, el motor de recomendaciones de tarifa y no-show calculaban "hoy"
// SIEMPRE con el default de plataforma (`America/Mexico_City`), aunque la property
// real esté en Cancún/Los Cabos/Tijuana/Puerto Vallarta. Ver
// `packages/core-tenancy/src/fecha-negocio.ts::resolverZonaHorariaNegocio` para el
// ÚNICO punto de esta decisión, y `packages/domain-hoteles/migrations/
// 030_zona_horaria_property.sql` para la columna real (`hoteles.property_config.
// timezone`, nullable, sin default en SQL).
//
// Este archivo es la ÚNICA superficie HTTP para que owner/gm (mismo nivel que
// gestión de catálogo, `admin-catalogo.ts`) lea/configure esa columna -- mismo
// criterio de validación que `citas/admin.ts::optionalTimeZone` (leído primero como
// plantilla): valida CUALQUIER timezone IANA real con `Intl.DateTimeFormat`, nunca
// restringe a una lista cerrada -- el `<select>` del panel web (ConfiguracionSection)
// solo ofrece los 6 más comunes de México como CONVENIENCIA de UI, nunca como
// restricción del backend (un hotel con matriz fuera de México, o un timezone IANA
// mexicano menos común, sigue pudiendo guardarse).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { resolverZonaHorariaNegocio, ZONA_HORARIA_NEGOCIO_DEFAULT } from "@atiende/core-tenancy";
import { ADMIN_ROLES, PropertyConfigUnavailableError } from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ConfiguracionBody {
  /** `string` -- timezone IANA nuevo. `null` -- limpia la configuración de vuelta al
   *  default de plataforma. `undefined` -- campo no enviado, error de validación
   *  (a diferencia de PATCH parcial, este PUT reemplaza el único campo que existe
   *  hoy; si el futuro agrega más campos a `property_config`, este body deja de ser
   *  un reemplazo total y esto deberá revisarse). */
  readonly timezone?: unknown;
}

/** Mismo criterio EXACTO que `citas/admin.ts::optionalTimeZone` (leído primero como
 *  plantilla) -- `Intl.DateTimeFormat` es la única fuente de verdad de "qué es un
 *  timezone IANA válido" en todo este repo, nunca una lista propia que pueda
 *  divergir del catálogo real de tzdata. */
function requireTimeZoneOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100) {
    throw Errors.validation('timezone: se esperaba un texto de timezone IANA (ej. "America/Cancun"), o null para volver al default de plataforma.');
  }
  const raw = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
  } catch {
    throw Errors.validation(`timezone: "${raw}" no es un timezone IANA válido (ej. "America/Mexico_City", "America/Cancun").`);
  }
  return raw;
}

export function hotelesPropertyConfigRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const configuracionPath = "/hoteles/:propertyId/configuracion";
  app.use(configuracionPath, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Cualquier rol de staff con acceso puede VER la zona configurada (transparencia,
  // mismo criterio que el resto de configuración de solo-lectura) -- solo
  // owner/gm puede cambiarla (ver PUT abajo).
  app.get(configuracionPath, async (c) => {
    const propertyId = c.req.param("propertyId");
    const repo = deps.hotelesRepo(c.get("db"));
    const timezone = await repo.findPropertyTimezone(propertyId);
    return c.json({ timezone, timezonePorDefecto: ZONA_HORARIA_NEGOCIO_DEFAULT, timezoneEfectiva: resolverZonaHorariaNegocio(timezone) });
  });

  app.put(configuracionPath, async (c) => {
    assertVerticalRole(c, ADMIN_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<ConfiguracionBody>(c.req.raw, 1024);
    if (raw.timezone === undefined) throw Errors.validation("timezone: campo requerido (string IANA, o null para volver al default de plataforma).");
    const timezone = requireTimeZoneOrNull(raw.timezone);

    const repo = deps.hotelesRepo(c.get("db"));
    try {
      await repo.upsertPropertyTimezone(propertyId, organizationId, timezone, c.get("userId"));
    } catch (err) {
      if (err instanceof PropertyConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }
    return c.json({ timezone, timezonePorDefecto: ZONA_HORARIA_NEGOCIO_DEFAULT, timezoneEfectiva: resolverZonaHorariaNegocio(timezone) });
  });

  return app;
}
