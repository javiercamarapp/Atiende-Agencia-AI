// L-22 -- calendario de dias inhabiles de licitaciones.
//
//   GET    /licitaciones/:propertyId/dias-inhabiles?tenderId=   oficiales de plataforma (2026-2027), sugeridos por validar y
//                                                               los declarados por la organizacion (cualquier rol)
//   POST   /licitaciones/:propertyId/dias-inhabiles             { fecha, nombre, tenderId?, publicadoPor?, fuente? } (DECISION_ROLES; nace por_validar)
//   DELETE /licitaciones/:propertyId/dias-inhabiles/:id         quita (soft delete sellado) un dia declarado (DECISION_ROLES)
//
// Declarar o quitar un dia inhabil cambia plazos LEGALES (pago, inconformidad, recordatorios), por
// eso exige DECISION_ROLES (owner/admin/analyst) y la RLS lo refuerza (migracion 032). Los oficiales
// de plataforma viven en codigo (`dias-inhabiles.ts`) y no se editan por esta API.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (migracion 032 pendiente): el repositorio lanza
// `DiaInhabilNotAvailableError` dentro de SAVEPOINT. La lectura responde `available: false` (con los
// oficiales y sugeridos, que no dependen de la base); las escrituras 503. Nunca 500.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  DECISION_ROLES,
  DIAS_INHABILES_COBERTURA_OFICIAL,
  DIAS_INHABILES_OFICIALES,
  DIAS_INHABILES_SUGERIDOS,
  DIAS_INHABILES_TIME_ZONE,
  DIAS_INHABILES_VALIDACION_NOTE,
  DiaInhabilDuplicateError,
  DiaInhabilNotAvailableError,
  DiaInhabilValidationError,
  buildCalendarioPlazos,
  parseDiaInhabilCreate,
} from "@atiende/domain-licitaciones";
import type { DiaInhabilRecord, LicitacionesRole } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_BODY_BYTES = 8 * 1024;

function unavailable(): Error {
  return Errors.serviceUnavailable("El calendario de días inhábiles por organización aún no está disponible en este ambiente (falta la migración 032 de licitaciones).");
}

function mapError(err: unknown): never {
  if (err instanceof DiaInhabilValidationError) throw Errors.validation(err.message);
  if (err instanceof DiaInhabilDuplicateError) throw Errors.conflict(err.message);
  if (err instanceof DiaInhabilNotAvailableError) throw unavailable();
  throw err;
}

export function licitacionesDiasInhabilesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/dias-inhabiles";
  const factory = deps.licitacionesDiasInhabilesRepo;

  for (const path of [base, `${base}/:id`]) app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(base, async (c) => {
    const rawTender = c.req.query("tenderId");
    if (rawTender !== undefined && !UUID_RE.test(rawTender)) throw Errors.validation("tenderId: se esperaba un UUID.");
    const organizationId = c.get("organizationId");
    if (rawTender) {
      const tender = await deps.licitacionesRepo(c.get("db")).findTender(organizationId, rawTender);
      if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
    }
    let declarados: readonly DiaInhabilRecord[] = [];
    let available = false;
    if (factory) {
      try {
        declarados = await factory(c.get("db")).list(organizationId, rawTender ?? undefined);
        available = true;
      } catch (err) {
        if (!(err instanceof DiaInhabilNotAvailableError)) throw err;
      }
    }
    const calendario = buildCalendarioPlazos({ declarados, tenderId: rawTender ?? null });
    return c.json({
      available,
      timeZone: DIAS_INHABILES_TIME_ZONE,
      coberturaOficial: DIAS_INHABILES_COBERTURA_OFICIAL,
      oficiales: DIAS_INHABILES_OFICIALES,
      sugeridos: DIAS_INHABILES_SUGERIDOS,
      declarados,
      efectivos: calendario.holidays,
      nota: DIAS_INHABILES_VALIDACION_NOTE,
      puedeEditar: (DECISION_ROLES as readonly string[]).includes(c.get("verticalRole") as string),
    });
  });

  app.post(base, async (c) => {
    assertVerticalRole(c, DECISION_ROLES as readonly LicitacionesRole[]);
    if (!factory) throw unavailable();
    const raw = await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw Errors.validation("El cuerpo debe ser un objeto JSON.");
    const organizationId = c.get("organizationId");
    try {
      const input = parseDiaInhabilCreate(raw as Record<string, unknown>);
      if (input.tenderId) {
        const tender = await deps.licitacionesRepo(c.get("db")).findTender(organizationId, input.tenderId);
        if (!tender) throw Errors.notFound("Convocatoria no encontrada.");
      }
      const record = await factory(c.get("db")).create(organizationId, c.get("userId"), input);
      logEvent(c, "info", "licitaciones_dia_inhabil_declarado", { alcance: record.alcance, anio: record.fecha.slice(0, 4) });
      return c.json(record, 201);
    } catch (err) {
      return mapError(err);
    }
  });

  app.delete(`${base}/:id`, async (c) => {
    assertVerticalRole(c, DECISION_ROLES as readonly LicitacionesRole[]);
    if (!factory) throw unavailable();
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.validation("id: se esperaba un UUID.");
    try {
      const removed = await factory(c.get("db")).remove(c.get("organizationId"), id);
      if (!removed) throw Errors.notFound("Día inhábil no encontrado.");
      logEvent(c, "info", "licitaciones_dia_inhabil_quitado", {});
      return c.json({ ok: true });
    } catch (err) {
      return mapError(err);
    }
  });

  return app;
}
