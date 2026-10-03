// H-01 (P0) -- BOVEDA DE IDENTIDAD + REGISTRO MIGRATORIO + PURGA CON DOBLE CONTROL.
// Superficie HTTP de `@atiende/domain-hoteles::identity` (modelo en
// packages/domain-hoteles/migrations/031_hoteles_boveda_identidad.sql).
//
// Principios (ver el comentario de la migracion):
//   - El documento se cifra AQUI (AES-256-GCM, llave en el entorno): la base solo guarda el
//     sobre. Sin llave configurada, captura/revelacion responden 503 -- nunca en claro.
//   - Los metadatos (tipo, ultimos 4, nacionalidad, retencion) se listan sin descifrar;
//     el documento completo SOLO sale por POST .../revelar, con motivo obligatorio y huella
//     en la bitacora (misma transaccion), y con `Cache-Control: no-store`.
//   - Doble control de la purga: quien solicita (owner/gm) NO puede decidir; la base lo hace
//     cumplir (funcion + CHECK), esta capa solo traduce el error.
//   - REGLA DURA de compatibilidad con la base sin migrar: el repositorio degrada las
//     lecturas a `disponible: false` y las escrituras a 503 (SAVEPOINT, ver
//     PostgresIdentityRepository) -- nunca un 500, nunca romper un flujo existente.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { assertVerticalRole, authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio, resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import {
  IDENTITY_ADMIN_ROLES,
  IDENTITY_CAPTURE_ROLES,
  IDENTITY_REVEAL_ROLES,
  IdentityAccessDeniedError,
  IdentityBlockedError,
  IdentityConflictError,
  IdentityDecryptError,
  IdentityDoubleControlError,
  IdentityInvalidInputError,
  IdentityPurgedError,
  IdentityRequestResolvedError,
  IdentityUnavailableError,
  IdentityVaultService,
  PostgresIdentityRepository,
  PrivacyAccessDeniedError,
  PrivacyConflictError,
  PrivacyDoubleControlError,
  PrivacyInvalidInputError,
  PrivacyNotFoundError,
  PrivacyUnavailableError,
  assertConsentMatchesNotice,
  parseConsentFields,
  computeMigratoryRetentionUntil,
  createIdentityCipher,
  parseCaptureIdentityInput,
  parseIdentityKey,
  parseReason,
  type IdentityCipher,
  type IdentityRepository,
  type IdentityVaultRecord,
  type IdentityPurgeRequestRecord,
  type IdentityAccessLogRecord,
  type MigratoryRegistrationRecord,
} from "@atiende/domain-hoteles";
import { Errors } from "../../../errors.ts";
import { privacyRepo, serializeConsent } from "./privacidad-comun.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 8 * 1024;

const cipherCache = new WeakMap<object, IdentityCipher | null>();

/** Cifrador de la boveda segun el entorno (memoizado por `deps.env`). Una llave presente
 *  pero invalida es un error de configuracion explicito (503), no "sin llave" en silencio. */
export function resolveCipher(deps: AppDeps): IdentityCipher | null {
  if (cipherCache.has(deps.env)) return cipherCache.get(deps.env) ?? null;
  let cipher: IdentityCipher | null = null;
  try {
    const key = parseIdentityKey(deps.env.hotelesIdentityKey);
    cipher = key ? createIdentityCipher(key, deps.env.hotelesIdentityKeyVersion) : null;
  } catch (err) {
    throw Errors.serviceUnavailable(err instanceof Error ? err.message : "HOTELES_IDENTITY_KEY invalida.");
  }
  cipherCache.set(deps.env, cipher);
  return cipher;
}

function identityRepo(deps: AppDeps, c: Context<CoreAuthHonoEnv>): IdentityRepository {
  const db = c.get("db");
  return deps.hotelesIdentidadRepo ? deps.hotelesIdentidadRepo(db) : new PostgresIdentityRepository(db);
}

/** Traduce los errores de dominio de la boveda a respuestas HTTP (nunca un 500 crudo). */
export function toApiError(err: unknown): unknown {
  if (err instanceof IdentityUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof IdentityAccessDeniedError) return Errors.forbidden(err.message);
  if (err instanceof IdentityDoubleControlError) return Errors.forbidden(err.message);
  if (err instanceof IdentityInvalidInputError) return Errors.validation(err.message);
  if (err instanceof IdentityPurgedError) return Errors.conflict(err.message);
  if (err instanceof IdentityBlockedError) return Errors.conflict(err.message);
  if (err instanceof IdentityRequestResolvedError) return Errors.conflict(err.message);
  if (err instanceof IdentityConflictError) return Errors.conflict(err.message);
  if (err instanceof IdentityDecryptError) return Errors.serviceUnavailable(err.message);
  // H-02 (privacidad): mismos codigos que la boveda -- 503 migracion pendiente, 403 sin permiso/doble control, 409 estado, 400 entrada.
  if (err instanceof PrivacyUnavailableError) return Errors.serviceUnavailable(err.message);
  if (err instanceof PrivacyNotFoundError) return Errors.notFound(err.message);
  if (err instanceof PrivacyAccessDeniedError || err instanceof PrivacyDoubleControlError) return Errors.forbidden(err.message);
  if (err instanceof PrivacyInvalidInputError) return Errors.validation(err.message);
  if (err instanceof PrivacyConflictError) return Errors.conflict(err.message);
  return err;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toApiError(err);
  }
}

export function requireUuid(value: string, field: string): string {
  if (!UUID_RE.test(value)) throw Errors.validation(`${field}: se esperaba un UUID.`);
  return value;
}

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw Errors.validation("limit: entero entre 1 y 200.");
  return n;
}

export async function readBody(c: Context<CoreAuthHonoEnv>): Promise<Record<string, unknown>> {
  const raw = await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Errors.validation("El cuerpo debe ser un objeto JSON.");
  return raw as Record<string, unknown>;
}

export function serializeIdentity(r: IdentityVaultRecord) {
  return {
    id: r.id,
    huespedId: r.guestId,
    reservaId: r.reservationId,
    tipoDocumento: r.documentType,
    nacionalidad: r.nationality,
    ultimos4: r.documentLast4,
    versionLlave: r.keyVersion,
    estado: r.status,
    retencionHasta: r.retentionUntil,
    verificadaEn: r.verifiedAt,
    verificadaPor: r.verifiedBy,
    capturadaPor: r.capturedBy,
    creadaEn: r.createdAt,
    purgadaEn: r.purgedAt,
    // Bloqueo previo a la purga (migracion 032); todo `null` en una base sin ella.
    bloqueadaEn: r.blockedAt,
    bloqueadaHasta: r.blockedUntil,
    ventanaBloqueoDias: r.blockWindowDays,
    motivoBloqueo: r.blockReason,
    bloqueadaPor: r.blockedBy,
  };
}
function serializePurge(r: IdentityPurgeRequestRecord) {
  return { id: r.id, identidadId: r.vaultId, solicitadaPor: r.requestedBy, motivo: r.reason, estado: r.status, decididaPor: r.decidedBy, decididaEn: r.decidedAt, notaDecision: r.decisionNote, creadaEn: r.createdAt };
}
function serializeLog(r: IdentityAccessLogRecord) {
  return { id: r.id, identidadId: r.vaultId, actorId: r.actorUserId, accion: r.action, motivo: r.reason, creadaEn: r.createdAt };
}
function serializeMigratory(r: MigratoryRegistrationRecord) {
  return {
    id: r.id,
    reservaId: r.reservationId,
    huespedId: r.guestId,
    identidadId: r.vaultId,
    nacionalidad: r.nationality,
    llegada: r.arrivalDate,
    salida: r.departureDate,
    estado: r.status,
    constancia: r.constanciaRef,
    reportadoEn: r.reportedAt,
    reportadoPor: r.reportedBy,
    creadoEn: r.createdAt,
    // Conservacion del registro textual (sin imagen): salida + 365 dias por defecto. NO la purga la
    // retencion de la imagen (ver MIGRATORY_RETENTION_DAYS_DEFAULT en domain-hoteles).
    retencionRegistroHasta: computeMigratoryRetentionUntil(r.departureDate),
  };
}

export function hotelesIdentidadRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  for (const base of ["identidad", "identidad-purgas", "registro-migratorio"]) {
    app.use(`/hoteles/:propertyId/${base}`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
    app.use(`/hoteles/:propertyId/${base}/*`, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  }

  const llaveConfigurada = (): boolean => resolveCipher(deps) !== null;

  // ---- Boveda ----

  app.get("/hoteles/:propertyId/identidad", async (c) => {
    assertVerticalRole(c, IDENTITY_CAPTURE_ROLES);
    const propertyId = c.req.param("propertyId");
    const guestId = c.req.query("huespedId");
    const estado = c.req.query("estado");
    if (guestId !== undefined) requireUuid(guestId, "huespedId");
    if (estado !== undefined && estado !== "activo" && estado !== "bloqueada" && estado !== "purgado") throw Errors.validation("estado: 'activo', 'bloqueada' o 'purgado'.");
    const result = await guarded(() => identityRepo(deps, c).listIdentities(propertyId, { guestId, status: estado, limit: parseLimit(c.req.query("limit")) }));
    return c.json({ disponible: result.available, llaveConfigurada: llaveConfigurada(), items: result.items.map(serializeIdentity) });
  });

  app.post("/hoteles/:propertyId/identidad", async (c) => {
    assertVerticalRole(c, IDENTITY_CAPTURE_ROLES);
    const propertyId = c.req.param("propertyId");
    const rawBody = await readJsonCapped<unknown>(c.req.raw, MAX_BODY_BYTES);
    const input = await guarded(async () => parseCaptureIdentityInput(rawBody));
    // H-02: consentimiento OPCIONAL ligado a la captura (aviso aceptado, finalidades, canal, evidencia). Se valida
    // ANTES de capturar y se registra en la MISMA transaccion: si la base lo rechaza, la captura se revierte.
    const rawConsent = rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>).consentimiento : undefined;
    const consent = rawConsent === undefined || rawConsent === null ? null : await guarded(async () => parseConsentFields(rawConsent));
    if (consent) {
      const privacy = privacyRepo(deps, c);
      const notice = await guarded(() => privacy.findNotice(propertyId, consent.noticeId));
      if (notice) await guarded(async () => assertConsentMatchesNotice(consent, notice));
      // Sin aviso: o la base no tiene 032 (la captura sigue sin ledger) o el aviso no existe en esta property (400).
      else if ((await guarded(() => privacy.listNotices(propertyId, { limit: 1 }))).available) throw Errors.validation("avisoId: el aviso no existe en esta property.");
    }
    const hotelesRepo = deps.hotelesRepo(c.get("db"));
    const today = hoyFechaNegocio(resolverZonaHorariaNegocio(await hotelesRepo.findPropertyTimezone(propertyId)));
    // El plazo de la imagen cuenta desde el check-out de la reserva ligada (si no hay, desde hoy).
    // La reserva es de la tabla base (existe en toda base); una reserva ajena/inexistente la
    // rechaza la base al insertar, igual que antes.
    const checkOutDate = input.reservationId ? ((await hotelesRepo.findReservation(propertyId, input.reservationId))?.checkOutDate ?? null) : null;
    const service = new IdentityVaultService(identityRepo(deps, c), resolveCipher(deps));
    const record = await guarded(() => service.capture({ propertyId, actorUserId: c.get("userId"), today, checkOutDate, input }));
    let consentimiento: Record<string, unknown> | null = null;
    if (consent) {
      try {
        const saved = await privacyRepo(deps, c).recordConsent(
          propertyId,
          { id: randomUUID(), guestId: input.guestId, vaultId: record.id, noticeId: consent.noticeId, acceptedMandatory: consent.acceptedMandatory, acceptedOptional: consent.acceptedOptional, channel: consent.channel, evidenceMethod: consent.evidenceMethod, sensitiveData: consent.sensitiveData },
          c.get("userId"),
        );
        consentimiento = { estado: "registrado", ...serializeConsent(saved) };
      } catch (err) {
        // Base sin la migracion 032 (SAVEPOINT ya recupero la sesion): la captura sigue valiendo, sin ledger.
        if (!(err instanceof PrivacyUnavailableError)) throw toApiError(err);
        consentimiento = { estado: "no_disponible" };
      }
    }
    c.header("Cache-Control", "no-store");
    return c.json({ identidad: serializeIdentity(record), consentimiento }, 201);
  });

  app.post("/hoteles/:propertyId/identidad/:identidadId/verificar", async (c) => {
    assertVerticalRole(c, IDENTITY_REVEAL_ROLES);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("identidadId"), "identidadId");
    const repo = identityRepo(deps, c);
    await guarded(async () => {
      if (!(await repo.findIdentity(propertyId, id))) throw Errors.notFound("Identidad no encontrada.");
      await repo.verifyIdentity(id, c.get("userId"));
    });
    const after = await guarded(() => repo.findIdentity(propertyId, id));
    return c.json({ identidad: after ? serializeIdentity(after) : null });
  });

  app.post("/hoteles/:propertyId/identidad/:identidadId/revelar", async (c) => {
    assertVerticalRole(c, IDENTITY_REVEAL_ROLES);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("identidadId"), "identidadId");
    const body = await readBody(c);
    const reason = await guarded(async () => parseReason(body.motivo));
    const service = new IdentityVaultService(identityRepo(deps, c), resolveCipher(deps));
    const { record, payload } = await guarded(() => service.reveal({ propertyId, vaultId: id, reason, actorUserId: c.get("userId") }));
    // El documento en claro nunca debe quedar en caches intermedios ni del navegador.
    c.header("Cache-Control", "no-store");
    return c.json({
      identidad: serializeIdentity(record),
      documento: {
        nombreCompleto: payload.fullName,
        numeroDocumento: payload.documentNumber,
        fechaNacimiento: payload.birthDate,
        paisEmisor: payload.issuingCountry,
        vigenciaHasta: payload.expiryDate,
        mrz: payload.mrz,
      },
    });
  });

  app.get("/hoteles/:propertyId/identidad/:identidadId/accesos", async (c) => {
    assertVerticalRole(c, IDENTITY_ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("identidadId"), "identidadId");
    const result = await guarded(() => identityRepo(deps, c).listAccessLog(propertyId, { vaultId: id, limit: parseLimit(c.req.query("limit")) }));
    return c.json({ disponible: result.available, items: result.items.map(serializeLog) });
  });

  app.post("/hoteles/:propertyId/identidad/:identidadId/solicitar-purga", async (c) => {
    assertVerticalRole(c, IDENTITY_ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const id = requireUuid(c.req.param("identidadId"), "identidadId");
    const body = await readBody(c);
    const reason = await guarded(async () => parseReason(body.motivo));
    const repo = identityRepo(deps, c);
    const requestId = await guarded(async () => {
      if (!(await repo.findIdentity(propertyId, id))) throw Errors.notFound("Identidad no encontrada.");
      return repo.requestPurge(id, reason, c.get("userId"));
    });
    return c.json({ solicitudId: requestId }, 201);
  });

  // ---- Solicitudes de purga (doble control) ----

  app.get("/hoteles/:propertyId/identidad-purgas", async (c) => {
    assertVerticalRole(c, IDENTITY_ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const estado = c.req.query("estado");
    if (estado !== undefined && estado !== "pendiente" && estado !== "ejecutada" && estado !== "rechazada" && estado !== "en_bloqueo") throw Errors.validation("estado: pendiente, en_bloqueo, ejecutada o rechazada.");
    const result = await guarded(() => identityRepo(deps, c).listPurgeRequests(propertyId, { status: estado, limit: parseLimit(c.req.query("limit")) }));
    return c.json({ disponible: result.available, items: result.items.map(serializePurge) });
  });

  app.post("/hoteles/:propertyId/identidad-purgas/:solicitudId/decidir", async (c) => {
    assertVerticalRole(c, IDENTITY_ADMIN_ROLES);
    const propertyId = c.req.param("propertyId");
    const requestId = requireUuid(c.req.param("solicitudId"), "solicitudId");
    const body = await readBody(c);
    if (typeof body.aprobar !== "boolean") throw Errors.validation("aprobar: se esperaba true o false.");
    let nota: string | null = null;
    if (body.nota !== undefined && body.nota !== null) {
      if (typeof body.nota !== "string" || body.nota.trim().length > 300) throw Errors.validation("nota: texto de hasta 300 caracteres.");
      nota = body.nota.trim() || null;
    }
    const repo = identityRepo(deps, c);
    const resultado = await guarded(async () => {
      if (!(await repo.findPurgeRequest(propertyId, requestId))) throw Errors.notFound("Solicitud no encontrada.");
      return repo.decidePurge(requestId, body.aprobar as boolean, nota, c.get("userId"));
    });
    return c.json({ resultado });
  });

  // ---- Registro migratorio ----

  app.get("/hoteles/:propertyId/registro-migratorio", async (c) => {
    assertVerticalRole(c, IDENTITY_CAPTURE_ROLES);
    const propertyId = c.req.param("propertyId");
    const estado = c.req.query("estado");
    if (estado !== undefined && estado !== "pendiente" && estado !== "reportado") throw Errors.validation("estado: 'pendiente' o 'reportado'.");
    const result = await guarded(() => identityRepo(deps, c).listMigratoryRegistrations(propertyId, { status: estado, limit: parseLimit(c.req.query("limit")) }));
    return c.json({ disponible: result.available, items: result.items.map(serializeMigratory) });
  });

  app.post("/hoteles/:propertyId/registro-migratorio", async (c) => {
    assertVerticalRole(c, IDENTITY_CAPTURE_ROLES);
    const propertyId = c.req.param("propertyId");
    const body = await readBody(c);
    if (typeof body.reservaId !== "string") throw Errors.validation("reservaId: se esperaba un UUID.");
    if (typeof body.huespedId !== "string") throw Errors.validation("huespedId: se esperaba un UUID.");
    const reservationId = requireUuid(body.reservaId, "reservaId");
    const guestId = requireUuid(body.huespedId, "huespedId");
    let vaultId: string | null = null;
    if (body.identidadId !== undefined && body.identidadId !== null) {
      if (typeof body.identidadId !== "string") throw Errors.validation("identidadId: se esperaba un UUID.");
      vaultId = requireUuid(body.identidadId, "identidadId");
    }
    const record = await guarded(() => identityRepo(deps, c).createMigratoryRegistration({ propertyId, reservationId, guestId, vaultId, actorUserId: c.get("userId") }));
    return c.json({ registro: serializeMigratory(record) }, 201);
  });

  app.post("/hoteles/:propertyId/registro-migratorio/:registroId/reportar", async (c) => {
    assertVerticalRole(c, IDENTITY_CAPTURE_ROLES);
    const propertyId = c.req.param("propertyId");
    const registroId = requireUuid(c.req.param("registroId"), "registroId");
    const body = await readBody(c);
    if (typeof body.constancia !== "string" || body.constancia.trim().length < 1 || body.constancia.trim().length > 120) {
      throw Errors.validation("constancia: referencia o folio de la constancia (1 a 120 caracteres).");
    }
    const record = await guarded(() => identityRepo(deps, c).reportMigratoryRegistration(propertyId, registroId, (body.constancia as string).trim(), c.get("userId")));
    if (!record) throw Errors.notFound("Registro migratorio no encontrado.");
    return c.json({ registro: serializeMigratory(record) });
  });

  return app;
}
