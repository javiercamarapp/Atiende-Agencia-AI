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
import type { Context, MiddlewareHandler } from "hono";
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
  { method: "POST", pattern: /^\/superadmin\/soporte\/entrar$/, label: "entrar al panel de un cliente (sesion de soporte)" },
  { method: "POST", pattern: /^\/superadmin\/break-glass\/sesiones$/, label: "abrir break-glass" },
  { method: "POST", pattern: /^\/superadmin\/acciones\/intents\/[^/]+\/confirmar$/, label: "confirmar accion sugerida" },
  { method: "PUT", pattern: /^\/superadmin\/gasto-api\/organizaciones\/[^/]+\/tope$/, label: "cambiar tope de gasto de una organizacion" },
  { method: "PUT", pattern: /^\/superadmin\/gasto-api\/plataforma\/tope$/, label: "cambiar tope de gasto de plataforma" },
  // Gasto de IA por organizacion y rol (CHAT-07): leer el reporte y ver o cambiar el tope diario de turnos por rol.
  { method: "GET", pattern: /^\/superadmin\/gasto-api\/consumo-ia$/, label: "leer el consumo de IA por rol y sus alertas" },
  { method: "GET", pattern: /^\/superadmin\/gasto-api\/por-rol$/, label: "leer el gasto de IA por organizacion y rol" },
  { method: "GET", pattern: /^\/superadmin\/gasto-api\/organizaciones\/[^/]+\/topes-rol$/, label: "ver el tope diario de turnos por rol de una organizacion" },
  { method: "PUT", pattern: /^\/superadmin\/gasto-api\/organizaciones\/[^/]+\/topes-rol$/, label: "cambiar el tope diario de turnos por rol de una organizacion" },
  { method: "POST", pattern: /^\/superadmin\/facturacion\/organizaciones\/[^/]+\/checkout$/, label: "crear checkout de suscripcion" },
  { method: "POST", pattern: /^\/superadmin\/mfa\/reset$/, label: "resetear MFA de otro superadmin" },
  { method: "PUT", pattern: /^\/superadmin\/interruptores$/, label: "cambiar un interruptor de plataforma" },
  // Copiloto de superadmin (CHAT-17): confirmar la propuesta de apagar/encender un agente es el mismo efecto que PUT /superadmin/interruptores.
  { method: "POST", pattern: /^\/superadmin\/copiloto\/acciones\/confirmar$/, label: "confirmar una accion propuesta por el Copiloto" },
  { method: "POST", pattern: /^\/superadmin\/organizaciones\/acciones\/[^/]+\/confirmar$/, label: "confirmar gestion de organizacion" },
  { method: "POST", pattern: /^\/superadmin\/organizaciones\/acciones\/[^/]+\/aprobar$/, label: "aprobar (doble control) la gestion de una organizacion" },
  // Alta del equipo inicial (SA-L-26): invitar, reenviar (token nuevo) y revocar dan o quitan acceso al panel de una organizacion.
  { method: "POST", pattern: /^\/superadmin\/organizaciones\/[^/]+\/invitaciones$/, label: "invitar a una persona al equipo de una organizacion" },
  { method: "POST", pattern: /^\/superadmin\/organizaciones\/[^/]+\/invitaciones\/[^/]+\/reenviar$/, label: "reenviar una invitacion de equipo (token nuevo)" },
  { method: "DELETE", pattern: /^\/superadmin\/organizaciones\/[^/]+\/invitaciones\/[^/]+$/, label: "revocar una invitacion de equipo" },
  { method: "PUT", pattern: /^\/superadmin\/costos\/tipo-cambio$/, label: "cambiar el tipo de cambio del reporte de costos" },
  { method: "PUT", pattern: /^\/superadmin\/pyl\/infra$/, label: "capturar la infraestructura compartida del P&L" },
  { method: "PUT", pattern: /^\/superadmin\/planes\/[^/]+$/, label: "editar un plan del catalogo" },
  { method: "PUT", pattern: /^\/superadmin\/planes\/[^/]+\/limites\/[^/]+$/, label: "fijar un limite de plan" },
  { method: "DELETE", pattern: /^\/superadmin\/planes\/[^/]+\/limites\/[^/]+$/, label: "quitar un limite de plan" },
  { method: "POST", pattern: /^\/superadmin\/planes\/asignaciones\/[^/]+\/confirmar$/, label: "confirmar asignacion de plan a una organizacion" },
  // Contrato por cliente (SA-43): cambiar las condiciones comerciales de una organizacion.
  { method: "POST", pattern: /^\/superadmin\/contratos$/, label: "dar de alta el contrato de una organizacion" },
  { method: "POST", pattern: /^\/superadmin\/contratos\/[^/]+\/enmiendas$/, label: "enmendar el contrato de una organizacion" },
  // Zona CFO (SA-41): exportar datos financieros, asignar o retirar el rol `finanzas` y leer la bitacora de consultas.
  { method: "GET", pattern: /^\/superadmin\/pyl\/export\.csv$/, label: "exportar el P&L en CSV" },
  { method: "PUT", pattern: /^\/superadmin\/zona-cfo\/roles\/[^/]+$/, label: "asignar o retirar el rol finanzas" },
  { method: "GET", pattern: /^\/superadmin\/zona-cfo\/bitacora$/, label: "leer la bitacora de consultas financieras" },
  { method: "GET", pattern: /^\/superadmin\/zona-cfo\/roles$/, label: "listar los roles de la zona CFO" },
  // Lista de supresion de plataforma (SA-L-46): agregar un contacto como "no contactar".
  { method: "POST", pattern: /^\/superadmin\/supresion\/no-contactar$/, label: "agregar un contacto a la lista de no contactar" },
  // Cerebro de ventas (SA-L-38): editar la taxonomia de una vertical crea una version nueva de las reglas del scoring y del mensaje base.
  { method: "PUT", pattern: /^\/superadmin\/cerebro\/taxonomia\/[^/]+$/, label: "editar la taxonomia de una vertical del cerebro de ventas" },
];

export function isSensitiveRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  return SENSITIVE_ROUTES.some((r) => r.method === m && r.pattern.test(path));
}

export function stepUpRequiredError(message = "Esta acción exige verificar tu código MFA (step-up). Verifica y reintenta."): ApiError {
  return new ApiError(403, "stepup_required", message);
}

/**
 * Exige el step-up segun la politica de arriba. `obligatorio` = true (rol `finanzas` de la zona CFO,
 * ver zona-cfo.ts) NO admite degradarse: sin repositorio MFA, con la migracion 0025 sin aplicar o sin
 * factor activo la respuesta es 503/403 (falla CERRADO), porque ese rol no tiene un "camino anterior
 * sin MFA" que preservar.
 */
export async function exigirStepUp(deps: AppDeps, c: Context<CoreAuthHonoEnv>, opciones: { readonly obligatorio: boolean }): Promise<void> {
  const required = opciones.obligatorio || deps.env.superadminMfaRequired === true;
  const userId = c.get("userId");

  if (!deps.mfaRepo) {
    if (required) throw Errors.serviceUnavailable("La MFA es obligatoria pero no está disponible en este despliegue.");
    return;
  }
  const mfaRepo = deps.mfaRepo;
  const { availability, factor } = await deps.engine.withAppSession({ userId: null }, (db) => mfaRepo(db).getFactor(userId));
  if (availability === "not_migrated") {
    if (required) throw Errors.serviceUnavailable("La MFA es obligatoria pero la migración 0025 aún no está aplicada.");
    return;
  }
  if (factor?.status !== "active") {
    if (required) throw new ApiError(403, "mfa_enrollment_required", "La MFA es obligatoria: enrola tu autenticador en Seguridad antes de ejecutar esta acción.");
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
}

export function stepUpMiddleware(deps: AppDeps): MiddlewareHandler<CoreAuthHonoEnv> {
  return async (c, next) => {
    if (isSensitiveRoute(c.req.method, c.req.path)) await exigirStepUp(deps, c, { obligatorio: false });
    await next();
  };
}
