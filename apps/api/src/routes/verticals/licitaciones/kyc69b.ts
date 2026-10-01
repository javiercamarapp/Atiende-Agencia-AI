// L-08 -- KYC negativo contra la lista 69-B del SAT (art. 69-B del CFF) para el RFC de
// proveedores y competidores: consulta de un RFC o lote, fichas con semaforo y alerta de
// proveedor propio.
//
//   GET    /licitaciones/:propertyId/kyc-69b                  fichas + semaforo + alertas + estado de la lista (cualquier rol)
//   POST   /licitaciones/:propertyId/kyc-69b/consultar        { rfcs: string[] } (WRITE_ROLES; deja huella en la bitacora)
//   POST   /licitaciones/:propertyId/kyc-69b/fichas           { rfc, rol, nombre? } (WRITE_ROLES)
//   DELETE /licitaciones/:propertyId/kyc-69b/fichas/:id       (WRITE_ROLES)
//   GET    /licitaciones/:propertyId/kyc-69b/consultas        bitacora PRIVADA de la organizacion (DECISION_ROLES)
//
// SEGURIDAD: la lista del SAT es publica, pero el hecho de que una organizacion consulte un RFC es
// privado. El aislamiento por organizacion lo hace la base (migracion 031: funciones definer con
// auth.uid() + membresia, RLS en fichas y bitacora); aqui se valida estrictamente la entrada (RFC
// 12/13, lote <= 50), se limita el ritmo por usuario y se traduce el tope diario por organizacion a 429.
// El RFC viaja en el CUERPO (nunca en la URL) y no se escribe en los logs.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (migracion 031 o lista 69-B de despachos pendiente): el
// repositorio lanza `KycNotAvailableError` dentro de SAVEPOINT. Lecturas -> `available: false`;
// escrituras -> 503. Nunca 500.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import {
  DECISION_ROLES,
  KycNotAvailableError,
  KycRateLimitError,
  KycValidationError,
  WRITE_ROLES,
  isKycRole,
  parseNombreFicha,
  parseRfc,
  parseRfcBatch,
} from "@atiende/domain-licitaciones";
import type { LicitacionesRole } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CONSULTA_RATE_LIMIT = { max: 20, windowMs: 60_000 } as const;
const MAX_BODY_BYTES = 8 * 1024;

function unavailable(): Error {
  return Errors.serviceUnavailable("El KYC contra la lista 69-B del SAT aun no esta disponible en este ambiente.");
}

/** Errores tipados del dominio -> errores HTTP. El resto se repropaga. */
function mapKycError(err: unknown): never {
  if (err instanceof KycValidationError) throw Errors.validation(err.message);
  if (err instanceof KycRateLimitError) throw Errors.tooManyRequests(err.message);
  if (err instanceof KycNotAvailableError) throw unavailable();
  throw err;
}

export function licitacionesKyc69bRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const base = "/licitaciones/:propertyId/kyc-69b";
  const factory = deps.licitacionesKycRepo;

  for (const path of [base, `${base}/consultar`, `${base}/fichas`, `${base}/fichas/:id`, `${base}/consultas`]) {
    app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  app.get(base, async (c) => {
    if (!factory) return c.json({ available: false, lista: null, listaDisponible: false, periodo: null, fichas: [], alertas: [] });
    const repo = factory(c.get("db"));
    try {
      const resultado = await repo.listFichas(c.get("organizationId"));
      const lista = await repo.estadoLista();
      return c.json({ available: true, lista, ...resultado });
    } catch (err) {
      if (err instanceof KycNotAvailableError) return c.json({ available: false, lista: null, listaDisponible: false, periodo: null, fichas: [], alertas: [] });
      throw err;
    }
  });

  app.post(`${base}/consultar`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    if (!factory) throw unavailable();
    const allowed = await rateLimit(`licitaciones:kyc-69b:${c.get("userId")}`, CONSULTA_RATE_LIMIT.max, CONSULTA_RATE_LIMIT.windowMs, { category: "licitaciones:kyc-69b" });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas consultas seguidas. Espera un minuto.");
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    try {
      const lote = parseRfcBatch(raw.rfcs);
      const resultado = await factory(c.get("db")).consultar(c.get("organizationId"), lote);
      // Solo conteos: nunca el RFC consultado (la cartera de un tenant es privada, tambien en los logs).
      logEvent(c, "info", "licitaciones_kyc_69b_consulta", { rfcs: lote.length, listaDisponible: resultado.listaDisponible });
      return c.json(resultado);
    } catch (err) {
      return mapKycError(err);
    }
  });

  app.post(`${base}/fichas`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    if (!factory) throw unavailable();
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    try {
      const { rfc } = parseRfc(raw.rfc);
      if (!isKycRole(raw.rol)) throw new KycValidationError('rol: se esperaba "proveedor" o "competidor".');
      const nombre = parseNombreFicha(raw.nombre);
      const { id } = await factory(c.get("db")).addFicha(c.get("organizationId"), { rfc, rol: raw.rol, nombre });
      return c.json({ id }, 201);
    } catch (err) {
      return mapKycError(err);
    }
  });

  app.delete(`${base}/fichas/:id`, async (c) => {
    assertVerticalRole(c, WRITE_ROLES);
    if (!factory) throw unavailable();
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) throw Errors.validation("id: se esperaba un UUID.");
    try {
      const removed = await factory(c.get("db")).removeFicha(c.get("organizationId"), id);
      if (!removed) throw Errors.notFound("Ficha no encontrada.");
      return c.json({ ok: true });
    } catch (err) {
      return mapKycError(err);
    }
  });

  app.get(`${base}/consultas`, async (c) => {
    // La bitacora la ven solo los roles de decision (la RLS lo refuerza); el resto recibe 403.
    assertVerticalRole(c, DECISION_ROLES as readonly LicitacionesRole[]);
    if (!factory) return c.json({ available: false, consultas: [] });
    try {
      const consultas = await factory(c.get("db")).listConsultas(c.get("organizationId"), 100);
      return c.json({ available: true, consultas });
    } catch (err) {
      if (err instanceof KycNotAvailableError) return c.json({ available: false, consultas: [] });
      throw err;
    }
  });

  return app;
}
