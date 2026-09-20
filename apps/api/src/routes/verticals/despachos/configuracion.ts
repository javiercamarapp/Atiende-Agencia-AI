// FASE 3 (producto) — zona horaria por negocio, parte despachos (migración 012,
// `despachos.property_config`). Primera ruta HTTP real de este vertical para esta
// config -- antes de este archivo, `vencimientos.ts`/`cobranza.ts`/
// `cierre-mensual.ts` calculaban "hoy" SIEMPRE con el default de plataforma
// (`hoyFechaNegocio()` sin argumento) porque ninguna columna real existía todavía
// (ver el comentario de cabecera de la migración 012 y de
// `@atiende/core-tenancy::resolverZonaHorariaNegocio`).
//
// Clasificación de sesión: TODAS las rutas de este archivo corren en la sesión de
// STAFF autenticado (`dbSession(deps.engine)` -> `withAppSession({userId: <el staff
// real>})`) -- nunca sesión de sistema, no hay ningún caller de sistema real para
// esta configuración (mismo criterio que `restaurantes/admin-config.ts`).
//
// Autorización: LEER (GET) -- cualquier staff con acceso a la property
// (VER_CONFIGURACION_ROLES, incluye auditor/readonly, es lectura de config ya
// persistida). ESCRIBIR (PATCH) -- reservado a `admin` (el único "owner" real de
// despachos, GESTIONAR_CONFIGURACION_ROLES) -- mandato explícito de esta fase ("UI
// mínima para owner/gm"), mismo umbral que CERRAR_PERIODO_ROLES/STAFF_INVITE_ROLES.
// RLS real (migración 012) es la autoridad de fondo; esto es defensa en
// profundidad / mejor mensaje de error, mismo principio del resto del repo.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { DespachosConfigUnavailableError, GESTIONAR_CONFIGURACION_ROLES, VER_CONFIGURACION_ROLES } from "@atiende/domain-despachos";
import type { DespachosPropertyConfigRecord } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

interface ConfiguracionBody {
  readonly zona_horaria?: unknown;
}

/** Mismo criterio EXACTO que `citas/admin.ts::optionalTimeZone` (leído primero como
 * plantilla, ver el comentario de cabecera de
 * `@atiende/core-tenancy::resolverZonaHorariaNegocio`) -- valida que el string sea
 * un timezone IANA real ANTES de escribir la fila, para un 400 claro en vez de
 * confiar en que `resolverZonaHorariaNegocio` degrade en silencio al leerlo
 * después. A diferencia de `optionalTimeZone` (citas, columna NOT NULL con
 * default), aquí `null` es un valor válido explícito -- "borra la configuración,
 * vuelve al default de plataforma" -- la columna de la migración 012 es NULLABLE a
 * propósito. */
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

function serializeConfig(propertyId: string, organizationId: string, config: DespachosPropertyConfigRecord | null) {
  return { propertyId, organizationId, zonaHoraria: config?.zonaHoraria ?? null };
}

export function despachosConfiguracionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const path = "/despachos/:propertyId/configuracion";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Nunca 404: una property que nunca configuró zona horaria (fila ausente) se ve
  // como `zonaHoraria: null` -- el caller real de "hoy" (hoyFechaNegocio() vía
  // resolverZonaHorariaNegocio) ya sabe caer al default de plataforma con eso,
  // mismo criterio que `citas/admin.ts::GET .../tenant-config`.
  app.get(path, async (c) => {
    assertVerticalRole(c, VER_CONFIGURACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const repo = deps.despachosRepo(c.get("db"));
    const config = await repo.findPropertyConfig(propertyId);
    return c.json({ configuracion: serializeConfig(propertyId, organizationId, config) });
  });

  app.patch(path, async (c) => {
    assertVerticalRole(c, GESTIONAR_CONFIGURACION_ROLES);
    const propertyId = c.req.param("propertyId");
    const organizationId = c.get("organizationId");
    const userId = c.get("userId");
    const repo = deps.despachosRepo(c.get("db"));

    const raw = await readJsonCapped<ConfiguracionBody>(c.req.raw, 1024);
    const zonaHoraria = optionalNullableTimeZone(raw.zona_horaria);
    if (zonaHoraria === undefined) throw Errors.validation("zona_horaria: campo requerido -- un timezone IANA (string) o null.");

    const antes = await repo.findPropertyConfig(propertyId);

    let updated: DespachosPropertyConfigRecord;
    try {
      updated = await repo.upsertPropertyConfigZonaHoraria(propertyId, organizationId, zonaHoraria);
    } catch (err) {
      if (err instanceof DespachosConfigUnavailableError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }

    // FASE 3 (producto) — "configuración ... de zona horaria" (entityType
    // 'configuracion', mismo criterio que `configuracion.tenant_actualizada` de
    // citas/`configuracion.whatsapp_actualizada` de restaurantes). Best-effort real
    // vía el AuditSink compartido de este vertical (`ProductionDespachosAuditSink`,
    // ver `apps/api/src/production/despachos-audit-sink.ts`) -- nunca revierte el
    // upsert ya aplicado.
    await deps.despachosAuditSink.record({
      at: new Date().toISOString(),
      actorUserId: userId,
      actorEmail: c.get("userEmail") ?? null,
      organizationId,
      action: "despachos.configuracion:zona_horaria_actualizada",
      route: c.req.path,
      method: c.req.method,
      decision: "allowed",
      metadata: { propertyId, antes: antes?.zonaHoraria ?? null, despues: updated.zonaHoraria },
    });

    return c.json({ configuracion: serializeConfig(propertyId, organizationId, updated) });
  });

  return app;
}
