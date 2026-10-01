// Segundo factor TOTP del staff (L-01): alta, confirmacion, estado, step-up, regenerar
// codigos de respaldo y desactivacion. Las mismas rutas sirven a las 6 verticales (el JWT
// propio es el unico mecanismo de sesion), igual que `routes/auth.ts`.
//
// Todas autenticadas (`authMiddleware`) y SIN `dbSession`: cada metodo de
// `StaffSecurityRepository` abre su propia transaccion (ver `second-factor.ts`).
//
// Respuestas de error: 422 (codigo incorrecto), 429 (bloqueo), 403 (step-up requerido), 503
// (migracion pendiente) -- nunca 401, que el cliente interpreta como sesion vencida.
import { Hono } from "hono";
import {
  authMiddleware,
  buildOtpAuthUrl,
  encryptStaffTotpSecret,
  generateBackupCodes,
  generateTotpSecret,
  hashBackupCode,
  decryptStaffTotpSecret,
  signStepUpToken,
  STEP_UP_TTL_SECONDS,
  verifyStaffTotp,
} from "@atiende/core-auth";
import type { CoreAuthHonoEnv, StepUpScope } from "@atiende/core-auth";
import { StaffSecurityUnavailableError, TotpAlreadyEnrolledError, TotpNoPendingEnrollmentError, TotpNotEnrolledError, verifyPassword } from "@atiende/db";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { checkSecondFactor, orUnavailable, requireSecurityRepo, throwForSecondFactor } from "../second-factor.ts";
import type { SecondFactorInput } from "../second-factor.ts";
import type { AppDeps } from "../deps.ts";

const ISSUER = "Atiende";
const TWO_FACTOR_RATE_LIMIT = { max: 12, windowMs: 5 * 60_000 } as const;
const STEP_UP_SCOPES: readonly StepUpScope[] = ["contract_sensitive"];

interface CodeBody {
  readonly code?: unknown;
  readonly backupCode?: unknown;
  readonly password?: unknown;
  readonly scope?: unknown;
}

function pickSecondFactor(body: CodeBody): SecondFactorInput {
  const code = typeof body.code === "string" ? body.code.trim() : undefined;
  const backupCode = typeof body.backupCode === "string" ? body.backupCode.trim() : undefined;
  if (!code && !backupCode) throw Errors.validation("Falta el código de 6 dígitos o un código de respaldo.");
  if (code && code.length > 12) throw Errors.validation("code inválido.");
  if (backupCode && backupCode.length > 24) throw Errors.validation("backupCode inválido.");
  return backupCode ? { backupCode } : { code };
}

export function auth2faRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.use("/auth/2fa/*", authMiddleware(deps.env));
  app.use("/auth/step-up", authMiddleware(deps.env));

  async function throttle(c: { req: { raw: Request }; get: (k: "userId") => string }): Promise<void> {
    const ok = await rateLimit(`auth:2fa:${requestActor(c.req.raw, c.get("userId"))}`, TWO_FACTOR_RATE_LIMIT.max, TWO_FACTOR_RATE_LIMIT.windowMs, { category: "auth:login" });
    if (!ok) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");
  }

  /** Estado. `available: false` = la base todavia no tiene la migracion (la UI lo dice honestamente). */
  app.get("/auth/2fa/status", async (c) => {
    if (!deps.staffSecurityRepo) return c.json({ available: false, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 });
    try {
      const status = await deps.staffSecurityRepo.getTotpStatus(c.get("userId"));
      return c.json({ available: true, enabled: status.enrolled, pending: status.pending, lockedUntil: status.lockedUntil, backupCodesRemaining: status.backupCodesRemaining });
    } catch (err) {
      if (err instanceof StaffSecurityUnavailableError) return c.json({ available: false, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 });
      throw err;
    }
  });

  /** Inicia el alta: devuelve el secreto UNA vez (para el QR o la clave manual). No activa nada. */
  app.post("/auth/2fa/setup", async (c) => {
    const repo = requireSecurityRepo(deps);
    await throttle(c);
    const secret = generateTotpSecret();
    try {
      await orUnavailable(() => repo.beginTotpEnrollment(c.get("userId"), encryptStaffTotpSecret(secret, deps.env.jwtSecret)));
    } catch (err) {
      if (err instanceof TotpAlreadyEnrolledError) throw Errors.conflict("Ya tienes la verificación en dos pasos activa. Desactívala primero para reconfigurarla.");
      throw err;
    }
    return c.json({ secret, otpauthUrl: buildOtpAuthUrl({ issuer: ISSUER, accountEmail: c.get("userEmail"), secretBase32: secret }) }, 201);
  });

  /** Confirma el alta con el primer codigo; devuelve los codigos de respaldo UNA vez. */
  app.post("/auth/2fa/confirm", async (c) => {
    const repo = requireSecurityRepo(deps);
    const body = await readJsonCapped<CodeBody>(c.req.raw, 2 * 1024);
    if (typeof body.code !== "string" || !/^\d{6}$/u.test(body.code.trim())) throw Errors.validation("Escribe el código de 6 dígitos de tu app de autenticación.");
    await throttle(c);
    const userId = c.get("userId");
    const row = await orUnavailable(() => repo.getTotpSecret(userId));
    if (!row || row.confirmed) throw Errors.conflict("No hay un alta pendiente. Inicia la configuración de nuevo.");
    if (row.lockedUntil) throw Errors.secondFactorLocked(row.lockedUntil);

    let step: number | null = null;
    try {
      step = verifyStaffTotp(decryptStaffTotpSecret(row.secretCiphertext, deps.env.jwtSecret), body.code.trim(), Date.now());
    } catch {
      step = null;
    }
    if (step === null) {
      const locked = await orUnavailable(() => repo.registerTotpFailure(userId));
      if (locked) throw Errors.secondFactorLocked(locked);
      throw Errors.secondFactorInvalid();
    }
    const backupCodes = generateBackupCodes();
    try {
      await orUnavailable(() => repo.confirmTotpEnrollment(userId, step as number, backupCodes.map((code) => hashBackupCode(code))));
    } catch (err) {
      if (err instanceof TotpNoPendingEnrollmentError) throw Errors.conflict("No hay un alta pendiente. Inicia la configuración de nuevo.");
      throw err;
    }
    return c.json({ enabled: true, backupCodes }, 200);
  });

  /** Step-up: prueba un segundo factor vigente y emite un token de 5 min para UNA clase de accion. */
  app.post("/auth/step-up", async (c) => {
    requireSecurityRepo(deps);
    const body = await readJsonCapped<CodeBody>(c.req.raw, 2 * 1024);
    const scope = body.scope;
    if (typeof scope !== "string" || !(STEP_UP_SCOPES as readonly string[]).includes(scope)) throw Errors.validation("scope desconocido.");
    const input = pickSecondFactor(body);
    await throttle(c);
    const userId = c.get("userId");
    const result = await orUnavailable(() => checkSecondFactor(deps, userId, input));
    if (result !== "ok") {
      const status = result === "locked" ? await orUnavailable(() => requireSecurityRepo(deps).getTotpStatus(userId)) : null;
      throwForSecondFactor(result, status?.lockedUntil ?? undefined);
    }
    const token = await signStepUpToken({ userId, organizationId: c.get("organizationId"), scope: scope as StepUpScope }, deps.env.jwtSecret);
    return c.json({ stepUpToken: token, expiresInSeconds: STEP_UP_TTL_SECONDS }, 200);
  });

  /** Regenera los codigos de respaldo (los anteriores dejan de servir). Exige un segundo factor vigente. */
  app.post("/auth/2fa/backup-codes", async (c) => {
    const repo = requireSecurityRepo(deps);
    const body = await readJsonCapped<CodeBody>(c.req.raw, 2 * 1024);
    const input = pickSecondFactor(body);
    await throttle(c);
    const userId = c.get("userId");
    const result = await orUnavailable(() => checkSecondFactor(deps, userId, input));
    if (result !== "ok") {
      const status = result === "locked" ? await orUnavailable(() => repo.getTotpStatus(userId)) : null;
      throwForSecondFactor(result, status?.lockedUntil ?? undefined);
    }
    const backupCodes = generateBackupCodes();
    try {
      await orUnavailable(() => repo.replaceBackupCodes(userId, backupCodes.map((code) => hashBackupCode(code))));
    } catch (err) {
      if (err instanceof TotpNotEnrolledError) throw Errors.stepUpEnrollmentRequired();
      throw err;
    }
    return c.json({ backupCodes }, 200);
  });

  /** Desactiva el 2FA: exige la contrasena actual Y un segundo factor vigente. */
  app.post("/auth/2fa/disable", async (c) => {
    const repo = requireSecurityRepo(deps);
    const body = await readJsonCapped<CodeBody>(c.req.raw, 2 * 1024);
    if (typeof body.password !== "string" || body.password.length === 0) throw Errors.validation("password requerido.");
    const input = pickSecondFactor(body);
    await throttle(c);
    const userId = c.get("userId");
    const staff = await deps.coreRepo.findStaffById(userId);
    if (!staff || !(await verifyPassword(body.password, staff.passwordHash))) throw Errors.currentPasswordInvalid();
    const result = await orUnavailable(() => checkSecondFactor(deps, userId, input));
    if (result !== "ok") {
      const status = result === "locked" ? await orUnavailable(() => repo.getTotpStatus(userId)) : null;
      throwForSecondFactor(result, status?.lockedUntil ?? undefined);
    }
    await orUnavailable(() => repo.disableTotp(userId));
    return c.json({ enabled: false }, 200);
  });

  return app;
}
