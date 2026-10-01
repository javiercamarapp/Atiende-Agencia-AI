// MFA TOTP del superadmin de plataforma: estado, enrolamiento, verificacion
// (emite el token de step-up), reset por otro superadmin y bitacora de seguridad.
// Ver docs/SUPERADMIN_MFA.md y packages/db/migrations/0025_superadmin_mfa_switches_orgs.sql.
//
// Autenticacion, gateo de superadmin y write-guard de impersonacion corren ANTES
// (montados una vez en routes/superadmin.ts sobre `/superadmin/*`). El step-up de
// `POST /superadmin/mfa/reset` lo aplica `stepUpMiddleware` (mismo lugar).
//
// SESIONES: las funciones que reciben el resultado de verificar el codigo se
// llaman en sesion de SISTEMA (`withAppSession({ userId: null })`) -- el backend
// ya autentico al usuario con su JWT; un cliente con RPC directo no puede
// declarar "codigo correcto". Cada llamada abre su PROPIA transaccion y la cierra
// con COMMIT antes de que esta ruta responda un 4xx: asi el contador de intentos
// fallidos SOBREVIVE a la respuesta de error (con `dbSession` se revertiria).
import { Hono } from "hono";
import {
  ApiError,
  STEPUP_TTL_SECONDS,
  buildOtpauthUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  signStepUpToken,
  verifyTotp,
} from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { SuperadminSeguridadError } from "@atiende/db";
import type { MfaRepository, SecurityEventRow } from "@atiende/db";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import type { AppDeps } from "../deps.ts";

const ISSUER = "Atiende";
const NO_DISPONIBLE = "La MFA del superadmin todavía no está disponible en este despliegue (falta aplicar la migración 0025_superadmin_mfa_switches_orgs).";
const VERIFY_RATE = { max: 10, windowMs: 5 * 60_000 } as const;

export function mfaKeyMaterial(deps: AppDeps): string {
  return deps.env.mfaEncryptionKey && deps.env.mfaEncryptionKey.length >= 16 ? deps.env.mfaEncryptionKey : deps.env.jwtSecret;
}

/** Traduce el error tipado de la base a un ApiError con el status que corresponde. */
export function traducirErrorSeguridad(err: unknown): never {
  if (err instanceof SuperadminSeguridadError) {
    if (err.code === "forbidden") throw Errors.forbidden(err.message);
    if (err.code === "invalid") throw Errors.validation(err.message);
    if (err.code === "not_found") throw Errors.notFound(err.message);
    throw Errors.conflict(err.message);
  }
  throw err;
}

function serializeEvent(e: SecurityEventRow) {
  return { id: e.id, seq: e.seq, area: e.area, evento: e.event, actorUserId: e.actorUserId, targetUserId: e.targetUserId, organizationId: e.organizationId, detalle: e.detail, ocurrioEnMs: e.occurredAtMs };
}

interface VerificarBody {
  readonly codigo?: unknown;
}
interface ResetBody {
  readonly usuarioId?: unknown;
  readonly motivo?: unknown;
}

export function superadminMfaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const mfaRepo = deps.mfaRepo;

  const sistema = <T>(fn: (repo: MfaRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(mfaRepo!(db)));
  const comoCaller = <T>(callerId: string, fn: (repo: MfaRepository) => Promise<T>) => deps.engine.withAppSession({ userId: callerId }, (db) => fn(mfaRepo!(db)));

  app.get("/superadmin/mfa/estado", async (c) => {
    const required = deps.env.superadminMfaRequired === true;
    if (!mfaRepo) return c.json({ disponible: false, obligatoria: required, inscrito: false, pendiente: false, bloqueadoHastaMs: null });
    const { availability, factor } = await sistema((repo) => repo.getFactor(c.get("userId")));
    if (availability === "not_migrated") return c.json({ disponible: false, obligatoria: required, inscrito: false, pendiente: false, bloqueadoHastaMs: null });
    return c.json({
      disponible: true,
      obligatoria: required,
      inscrito: factor?.status === "active",
      pendiente: factor?.status === "pending",
      bloqueadoHastaMs: factor?.lockedUntilMs && factor.lockedUntilMs > Date.now() ? factor.lockedUntilMs : null,
    });
  });

  // Genera el secreto, lo guarda CIFRADO (pendiente hasta que un codigo correcto lo
  // active) y devuelve el URI otpauth + el secreto en base32 para captura manual.
  // El secreto se muestra UNA vez: no hay ruta que lo vuelva a entregar.
  app.post("/superadmin/mfa/enrolar", async (c) => {
    if (!mfaRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const callerId = c.get("userId");
    const secret = generateTotpSecret();
    const ciphertext = encryptTotpSecret(secret, mfaKeyMaterial(deps), callerId);
    try {
      const result = await sistema((repo) => repo.beginEnrollment(callerId, ciphertext));
      if (result.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
    } catch (err) {
      traducirErrorSeguridad(err);
    }
    return c.json(
      { secreto: secret, otpauthUri: buildOtpauthUri({ secretBase32: secret, accountName: c.get("userEmail"), issuer: ISSUER }) },
      201,
    );
  });

  // Verifica un codigo de 6 digitos. Sobre un factor PENDIENTE lo activa; sobre uno
  // ACTIVO emite el token de step-up (5 min, atado a este access token).
  app.post("/superadmin/mfa/verificar", async (c) => {
    if (!mfaRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:mfa-verificar:${requestActor(c.req.raw, callerId)}`, VERIFY_RATE.max, VERIFY_RATE.windowMs, { category: "admin" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos de verificación MFA en poco tiempo.");

    const raw = (await c.req.json().catch(() => ({}))) as VerificarBody;
    const codigo = typeof raw.codigo === "string" ? raw.codigo.replace(/\s+/gu, "") : "";
    if (!/^\d{6}$/u.test(codigo)) throw Errors.validation("codigo debe ser de 6 dígitos.");

    const { availability, factor } = await sistema((repo) => repo.getFactor(callerId));
    if (availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
    if (!factor) throw Errors.conflict("No tienes MFA enrolada: enrola tu autenticador primero.");
    if (factor.lockedUntilMs && factor.lockedUntilMs > Date.now()) {
      throw new ApiError(429, "mfa_bloqueado", "Demasiados códigos incorrectos: la verificación está bloqueada temporalmente.", { "Retry-After": String(Math.ceil((factor.lockedUntilMs - Date.now()) / 1000)) });
    }

    let secret: string;
    try {
      secret = decryptTotpSecret(factor.secretCiphertext, mfaKeyMaterial(deps), callerId);
    } catch {
      // Llave de servidor distinta a la que cifro el secreto (p. ej. se roto JWT_SECRET sin
      // SUPERADMIN_MFA_ENCRYPTION_KEY): no es un error del usuario ni un 500 -- otro
      // superadmin debe resetear el factor para re-enrolar.
      throw Errors.conflict("Tu factor MFA no se puede leer con la llave actual del servidor. Pide a otro superadmin que lo restablezca y vuelve a enrolar.");
    }
    const step = verifyTotp(secret, codigo, Date.now());
    const { result } = await sistema((repo) => repo.recordAttempt(callerId, step !== null, step));

    if (result === "locked") throw new ApiError(429, "mfa_bloqueado", "Demasiados códigos incorrectos: la verificación está bloqueada temporalmente.", { "Retry-After": "900" });
    if (result === "replay") throw new ApiError(401, "mfa_codigo_reusado", "Ese código ya se usó. Espera el siguiente código de tu autenticador.");
    if (result !== "ok" && result !== "activated") throw new ApiError(401, "mfa_codigo_invalido", "Código incorrecto.");

    const bearer = c.req.header("authorization")?.slice("Bearer ".length).trim() ?? "";
    const stepUpToken = await signStepUpToken(callerId, bearer, deps.env.jwtSecret, STEPUP_TTL_SECONDS);
    return c.json({ activado: result === "activated", stepUpToken, expiraEnSegundos: STEPUP_TTL_SECONDS });
  });

  // Resetea el factor de OTRO superadmin (dispositivo perdido). Step-up del caller
  // exigido por stepUpMiddleware; motivo >= 20 caracteres; queda en la bitacora.
  app.post("/superadmin/mfa/reset", async (c) => {
    if (!mfaRepo) throw Errors.serviceUnavailable(NO_DISPONIBLE);
    const callerId = c.get("userId");
    const raw = (await c.req.json().catch(() => ({}))) as ResetBody;
    const usuarioId = typeof raw.usuarioId === "string" ? raw.usuarioId.trim() : "";
    const motivo = typeof raw.motivo === "string" ? raw.motivo : "";
    if (usuarioId.length === 0) throw Errors.validation("usuarioId requerido.");
    try {
      const result = await comoCaller(callerId, (repo) => repo.reset(callerId, usuarioId, motivo));
      if (result.availability === "not_migrated") throw Errors.serviceUnavailable(NO_DISPONIBLE);
    } catch (err) {
      traducirErrorSeguridad(err);
    }
    return c.json({ ok: true });
  });

  // Bitacora de seguridad (mfa / interruptores / organizaciones), visible a cualquier superadmin.
  app.get("/superadmin/seguridad/bitacora", async (c) => {
    if (!mfaRepo) return c.json({ disponible: false, eventos: [] });
    const callerId = c.get("userId");
    const areaRaw = c.req.query("area");
    const area = areaRaw === "mfa" || areaRaw === "switch" || areaRaw === "org" ? areaRaw : null;
    if (areaRaw !== undefined && area === null) throw Errors.validation("area debe ser mfa, switch u org.");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 100 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Errors.validation("limit debe ser un entero entre 1 y 500.");
    const { availability, events } = await comoCaller(callerId, (repo) => repo.listEvents(callerId, area, limit));
    return c.json({ disponible: availability === "available", eventos: events.map(serializeEvent) });
  });

  return app;
}
