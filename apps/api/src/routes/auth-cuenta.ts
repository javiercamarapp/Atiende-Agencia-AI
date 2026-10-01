// Seguridad de la cuenta de staff (L-02, paridad de auth), parte "estado": sesiones activas (listar,
// cerrar una, cerrar todas las demas), estado de verificacion de correo y vinculos de Google
// (listar/desvincular; vincular vive en `auth-google.ts` porque comparte el flujo OAuth). Mismas rutas
// para las 6 verticales; hoy solo licitaciones tiene pantalla.
//
// Compatibilidad con la base sin migrar (migracion 0033): cada llamada a `staffSecurityRepo` abre SU
// PROPIA transaccion, asi que un SQLSTATE de "migracion pendiente" se traduce a
// `StaffSecurityUnavailableError` FUERA de ella. Las LECTURAS (`estado`, `listar`) degradan a
// `available: false` con 200 (lista vacia honesta, nunca 500); las ESCRITURAS responden 503 explicito.
// Principio: todo lo que se lista o cierra es de la cuenta autenticada (`c.get("userId")`), jamas un id
// de cuenta recibido en el cuerpo; un id de sesion/identidad ajeno responde 404 igual que uno inexistente.
import { Hono } from "hono";
import { authMiddleware, verifyRefreshToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { StaffSecurityUnavailableError, verifyPassword } from "@atiende/db";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../errors.ts";
import { readJsonCapped, requestActor } from "../http-security.ts";
import { issueSession } from "./auth.ts";
import type { AppDeps } from "../deps.ts";

const ACCION_RATE_LIMIT = { max: 20, windowMs: 5 * 60_000 } as const;
const PASSWORD_RATE_LIMIT = { max: 10, windowMs: 5 * 60_000 } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noDisponible() {
  return Errors.serviceUnavailable("Esta función todavía no está disponible en este ambiente (migración pendiente).");
}

/** Traduce "migracion pendiente" a 503 honesto (escrituras). */
async function orNoDisponible<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StaffSecurityUnavailableError) throw noDisponible();
    throw err;
  }
}

export function authCuentaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.use("/auth/account/*", authMiddleware(deps.env));
  app.use("/auth/sessions/*", authMiddleware(deps.env));
  app.use("/auth/google/desvincular", authMiddleware(deps.env));

  /** Estado de la cuenta para la pantalla de Seguridad: correo verificado, contrasena y vinculos de Google. */
  app.get("/auth/account/estado", async (c) => {
    const userId = c.get("userId");
    const staff = await deps.coreRepo.findStaffById(userId);
    if (!staff) throw Errors.unauthorized();
    let available = false;
    let identities: Array<{ id: string; email: string; linkedAt: string }> = [];
    if (deps.staffSecurityRepo) {
      try {
        identities = await deps.staffSecurityRepo.listGoogleIdentities(userId);
        available = true;
      } catch (err) {
        if (!(err instanceof StaffSecurityUnavailableError)) throw err;
      }
    }
    return c.json({
      email: staff.email,
      emailVerified: staff.emailVerifiedAt !== null,
      hasPassword: staff.passwordHash !== null,
      google: { configured: deps.env.googleOAuth !== null, available, identities },
    });
  });

  /**
   * Sesiones activas de la propia cuenta. POST (no GET) para poder recibir el refresh token del
   * dispositivo actual y marcarlo (`current`); el token se valida (firma + que sea de ESTA cuenta)
   * y nunca se devuelve ni se registra.
   */
  app.post("/auth/sessions/listar", async (c) => {
    const userId = c.get("userId");
    const body = await readJsonCapped<{ refreshToken?: unknown }>(c.req.raw, 4 * 1024);
    let currentJti: string | null = null;
    if (typeof body.refreshToken === "string" && body.refreshToken.length > 0) {
      try {
        const claims = await verifyRefreshToken(body.refreshToken, deps.env.jwtSecret);
        if (claims.sub === userId) currentJti = claims.jti;
      } catch {
        // token invalido o vencido: simplemente ninguna sesion se marca como actual
      }
    }
    if (!deps.staffSecurityRepo) return c.json({ available: false, sessions: [] }, 200);
    try {
      const sessions = await deps.staffSecurityRepo.listSessions(userId);
      return c.json({ available: true, sessions: sessions.map((s) => ({ ...s, current: s.id === currentJti })) }, 200);
    } catch (err) {
      if (err instanceof StaffSecurityUnavailableError) return c.json({ available: false, sessions: [] }, 200);
      throw err;
    }
  });

  /** Cierra UNA sesion de la propia cuenta: su refresh token deja de servir de inmediato. */
  app.post("/auth/sessions/cerrar", async (c) => {
    const userId = c.get("userId");
    const body = await readJsonCapped<{ sessionId?: unknown }>(c.req.raw, 1024);
    if (typeof body.sessionId !== "string" || !UUID_RE.test(body.sessionId)) throw Errors.validation("sessionId inválido.");
    const allowed = await rateLimit(`auth:sessions-cerrar:${requestActor(c.req.raw, userId)}`, ACCION_RATE_LIMIT.max, ACCION_RATE_LIMIT.windowMs, { category: "auth:token-issue" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");
    if (!deps.staffSecurityRepo) throw noDisponible();
    const repo = deps.staffSecurityRepo;
    const cerrada = await orNoDisponible(() => repo.revokeSession(userId, body.sessionId as string));
    if (!cerrada) throw Errors.notFound("Esa sesión ya no existe.");
    return c.json({ ok: true }, 200);
  });

  /**
   * "Cerrar mis otras sesiones": corte por fecha de TODAS las sesiones previas (incluso las que nunca se
   * registraron) y sesion nueva para el dispositivo actual (mismo patron que `change-password`), de modo
   * que ESTE dispositivo no se queda sin refresh token valido. El access token de las otras sesiones
   * sigue vivo hasta su `exp` (JWT sin estado, mismo limite que logout).
   */
  app.post("/auth/sessions/cerrar-todas", async (c) => {
    const userId = c.get("userId");
    const allowed = await rateLimit(`auth:sessions-cerrar-todas:${requestActor(c.req.raw, userId)}`, ACCION_RATE_LIMIT.max, ACCION_RATE_LIMIT.windowMs, { category: "auth:token-issue" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");
    if (!deps.staffSecurityRepo) throw noDisponible();
    const repo = deps.staffSecurityRepo;
    const staff = await deps.coreRepo.findStaffById(userId);
    if (!staff) throw Errors.unauthorized();
    await orNoDisponible(() => repo.revokeAllSessions(userId));
    return c.json(await issueSession(deps, staff.id, staff.email, staff.fullName, { c }), 200);
  });

  /** Desvincula una identidad de Google de la propia cuenta; exige la contrasena actual (si la cuenta tiene una). */
  app.post("/auth/google/desvincular", async (c) => {
    const userId = c.get("userId");
    const body = await readJsonCapped<{ identityId?: unknown; password?: unknown }>(c.req.raw, 4 * 1024);
    if (typeof body.identityId !== "string" || !UUID_RE.test(body.identityId)) throw Errors.validation("identityId inválido.");
    const allowed = await rateLimit(`auth:google-desvincular:${requestActor(c.req.raw, userId)}`, PASSWORD_RATE_LIMIT.max, PASSWORD_RATE_LIMIT.windowMs, { category: "auth:login" });
    if (!allowed) throw Errors.tooManyRequests("Demasiados intentos. Intenta de nuevo en unos minutos.");
    if (!deps.staffSecurityRepo) throw noDisponible();
    const repo = deps.staffSecurityRepo;
    const staff = await deps.coreRepo.findStaffById(userId);
    if (!staff) throw Errors.unauthorized();
    if (staff.passwordHash !== null) {
      if (typeof body.password !== "string" || body.password.length === 0 || !(await verifyPassword(body.password, staff.passwordHash))) throw Errors.currentPasswordInvalid();
    }
    const quitada = await orNoDisponible(() => repo.unlinkGoogleIdentity(userId, body.identityId as string));
    if (!quitada) throw Errors.notFound("Ese vínculo de Google ya no existe.");
    return c.json({ ok: true }, 200);
  });

  return app;
}
