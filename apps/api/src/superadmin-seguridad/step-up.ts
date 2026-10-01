// Step-up (MFA reciente) para las acciones sensibles del superadmin.
//
// Politica (ver docs/SUPERADMIN_MFA.md):
//   - Una accion es "sensible" si esta en SENSITIVE_ROUTES (lista explicita, no un
//     patron generico: agregar una ruta sensible nueva es una decision visible).
//   - Superadmin CON factor MFA activo: la accion exige `x-stepup-token` valido
//     (emitido por POST /superadmin/mfa/verificar, 5 min, atado al access token).
//   - Superadmin SIN factor: sin cambios (nada que hoy funcione se rompe antes de
//     enrolar) -- salvo SUPERADMIN_MFA_REQUIRED=1, que lo vuelve 403
//     `mfa_enrollment_required`.
//   - Base sin migrar (0025 sin aplicar) o `mfaRepo` ausente: sin cambios, salvo
//     SUPERADMIN_MFA_REQUIRED=1, que falla CERRADO con 503 (el operador pidio
//     obligatoriedad: no se degrada en silencio a "sin MFA").
import type { MiddlewareHandler } from "hono";
import { ApiError, TokenExpiredError, verifyStepUpToken } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../deps.ts";
import { Errors } from "../errors.ts";

export const STEPUP_HEADER = "x-stepup-token";

interface SensitiveRoute {
  readonly method: string;
  readonly pattern: RegExp;
  readonly label: string;
}

export const SENSITIVE_ROUTES: readonly SensitiveRoute[] = [
  { method: "POST", pattern: /^\/superadmin\/impersonacion\/sesiones$/, label: "iniciar impersonacion" },
  { method: "POST", pattern: /^\/superadmin\/break-glass\/sesiones$/, label: "abrir break-glass" },
  { method: "POST", pattern: /^\/superadmin\/acciones\/intents\/[^/]+\/confirmar$/, label: "confirmar accion sugerida" },
  { method: "PUT", pattern: /^\/superadmin\/gasto-api\/organizaciones\/[^/]+\/tope$/, label: "cambiar tope de gasto de una organizacion" },
  { method: "PUT", pattern: /^\/superadmin\/gasto-api\/plataforma\/tope$/, label: "cambiar tope de gasto de plataforma" },
  { method: "POST", pattern: /^\/superadmin\/facturacion\/organizaciones\/[^/]+\/checkout$/, label: "crear checkout de suscripcion" },
  { method: "POST", pattern: /^\/superadmin\/mfa\/reset$/, label: "resetear MFA de otro superadmin" },
  { method: "PUT", pattern: /^\/superadmin\/interruptores$/, label: "cambiar un interruptor de plataforma" },
  { method: "POST", pattern: /^\/superadmin\/organizaciones\/acciones\/[^/]+\/confirmar$/, label: "confirmar gestion de organizacion" },
];

export function isSensitiveRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return SENSITIVE_ROUTES.some((r) => r.method === m && r.pattern.test(path));
}

export function stepUpRequiredError(message = "Esta acción exige verificar tu código MFA (step-up). Verifica y reintenta."): ApiError {
  return new ApiError(403, "stepup_required", message);
}

export function stepUpMiddleware(deps: AppDeps): MiddlewareHandler<CoreAuthHonoEnv> {
  return async (c, next) => {
    if (!isSensitiveRoute(c.req.method, c.req.path)) {
      await next();
      return;
    }
    const required = deps.env.superadminMfaRequired === true;
    const userId = c.get("userId");

    if (!deps.mfaRepo) {
      if (required) throw Errors.serviceUnavailable("La MFA es obligatoria pero no está disponible en este despliegue.");
      await next();
      return;
    }
    const mfaRepo = deps.mfaRepo;
    const { availability, factor } = await deps.engine.withAppSession({ userId: null }, (db) => mfaRepo(db).getFactor(userId));
    if (availability === "not_migrated") {
      if (required) throw Errors.serviceUnavailable("La MFA es obligatoria pero la migración 0025 aún no está aplicada.");
      await next();
      return;
    }
    if (factor?.status !== "active") {
      if (required) throw new ApiError(403, "mfa_enrollment_required", "La MFA es obligatoria: enrola tu autenticador en Seguridad antes de ejecutar esta acción.");
      await next();
      return;
    }

    const stepUp = c.req.header(STEPUP_HEADER);
    const bearer = c.req.header("authorization")?.slice("Bearer ".length).trim() ?? "";
    if (!stepUp) throw stepUpRequiredError();
    try {
      await verifyStepUpToken(stepUp, bearer, userId, deps.env.jwtSecret);
    } catch (err) {
      if (err instanceof TokenExpiredError) throw new ApiError(403, "stepup_required", "Tu verificación MFA expiró. Verifica de nuevo y reintenta.");
      throw stepUpRequiredError();
    }
    await next();
  };
}
