// Fase 11 -- POST /rentas/onboarding/registro: onboarding self-serve del tenant de
// rentas (alta de organización + primera propiedad + al menos una unidad + admin
// desde el producto, sin intervención manual del equipo de Atiende). Hallazgo de
// auditoría (severidad CRÍTICA, "el onboarding self-serve de rentas está bloqueado en
// producción y ni siquiera tiene pantalla") -- CERRADO: `deps.rentasOnboardingRepo`
// ya resuelve a un adaptador real de producción
// (`apps/api/src/production/rentas-onboarding-repository.ts`, sobre
// `rentas.register_tenant_onboarding`, función `security definer` -- ver
// `packages/domain-rentas/migrations/016_onboarding_security_definer.sql`) y la
// pantalla real vive en `apps/web/src/verticals/rentas/pages/Registro.tsx`.
//
// PÚBLICA (sin sesión) a propósito -- mismo criterio que
// `POST /rentas/owner-portal/login`/`POST /auth/refresh` (rutas de arranque de sesión
// que por definición corren ANTES de que exista un `auth.uid()` real): usa
// `engine.withAppSession({userId: null}, ...)`, NUNCA `authMiddleware`/`dbSession`.
//
// Onboarding P0 (investigacion B §5.6-2/3):
//   * Tope por IP (10 registros por hora, categoria cerrada `auth:password-reset`: superficie publica que ahora envia correo) ANTES de
//     validar o hashear nada.
//   * Correo de verificacion al registrar: la cuenta nace sin verificar (`registro_autoservicio`) y `/auth/login` con contrasena la
//     rechaza hasta verificar. Tras confirmar el registro (transaccion ya cerrada: el token referencia al staff_user recien creado) se
//     crea el token de verificacion y el correo se ENCOLA en `rentas.messaging_outbox` (channel 'email', sesion de sistema; lo entrega el
//     despachador de correo de rentas). Best-effort: un fallo nunca revierte el registro; la respuesta dice honestamente si quedo encolado
//     (`correoVerificacion.encolado`). Reenvio sin sesion: POST /auth/email-verification/reenviar (auth-account.ts).
import { Hono } from "hono";
import { generateInviteToken } from "@atiende/core-auth";
import { rateLimit } from "@atiende/core-ratelimit";
import { hashPassword } from "@atiende/db";
import { validarCapturaOnboardingRentas, RentasDomainError } from "@atiende/domain-rentas";
import type { CapturaOnboardingRentasValidada } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, requestActor } from "../../../http-security.ts";
import { correoVerificacionCuenta, VERIFICACION_CORREO_TTL_MS } from "../../auth-account.ts";
import type { AppDeps } from "../../../deps.ts";
import { mapRentasDomainError } from "./reservas.ts";

export const REGISTRO_RENTAS_RATE_LIMIT = { max: 10, windowMs: 60 * 60_000 } as const;

interface OnboardingRegistroBody {
  readonly admin?: { readonly password?: unknown };
}

export function rentasOnboardingRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/rentas/onboarding/registro", async (c) => {
    const permitido = await rateLimit(`auth:registro-rentas:${requestActor(c.req.raw, "ip")}`, REGISTRO_RENTAS_RATE_LIMIT.max, REGISTRO_RENTAS_RATE_LIMIT.windowMs, { category: "auth:password-reset" });
    if (!permitido) throw Errors.tooManyRequests("Demasiados registros desde esta conexión. Intenta de nuevo más tarde.");
    const body = await readJsonCapped<OnboardingRegistroBody>(c.req.raw, 16 * 1024);

    let captura: CapturaOnboardingRentasValidada;
    try {
      captura = validarCapturaOnboardingRentas(body);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }

    // El hash SIEMPRE se calcula, ANTES de tocar el repositorio -- nunca deja la
    // contraseña en texto plano un instante más de lo necesario, mismo criterio que
    // `POST /auth/login`/`POST /rentas/owner-portal/activar` (hashPassword antes de
    // cualquier otra cosa que pueda fallar). `validarCapturaOnboardingRentas` ya
    // garantizó arriba que `body.admin.password` es un string de longitud válida --
    // este `typeof` es solo para que TypeScript lo sepa aquí también.
    const passwordCrudo = body.admin?.password;
    if (typeof passwordCrudo !== "string") throw new Error("inalcanzable: validarCapturaOnboardingRentas ya validó admin.password");
    const passwordHash = await hashPassword(passwordCrudo);

    const resultado = await deps.engine.withAppSession({ userId: null }, async (db) => {
      try {
        return await deps.rentasOnboardingRepo(db).registrarTenant({
          organizacion: { nombre: captura.organizacion.nombre, slugPropuesto: captura.slugPropuesto, tipoOrganizacion: captura.organizacion.tipoOrganizacion },
          primeraPropiedad: captura.primeraPropiedad,
          primerasUnidades: captura.primerasUnidades,
          admin: { nombreCompleto: captura.admin.nombreCompleto, correo: captura.admin.correo, passwordHash },
          primerOwner: captura.primerOwner,
        });
      } catch (err) {
        if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
        throw err;
      }
    });

    const encolado = await encolarCorreoVerificacion(deps, resultado, captura.admin.correo);
    return c.json({ ...resultado, correoVerificacion: { encolado } }, 201);
  });

  return app;
}

/** Crea el token de verificacion y encola el correo en el outbox de rentas (sesion de sistema). Nunca lanza. */
async function encolarCorreoVerificacion(deps: AppDeps, registro: { readonly organizationId: string; readonly propertyId: string; readonly staffId: string }, correo: string): Promise<boolean> {
  if (!deps.staffSecurityRepo) return false;
  try {
    const { tokenPlain, tokenHash } = generateInviteToken();
    await deps.staffSecurityRepo.createEmailVerificationToken({ staffId: registro.staffId, tokenHash, expiresAt: new Date(Date.now() + VERIFICACION_CORREO_TTL_MS).toISOString() });
    const mensaje = correoVerificacionCuenta(deps, "rentas", correo, tokenPlain);
    await deps.engine.withAppSession({ userId: null }, (db) =>
      deps.rentasRepo(db).enqueueMessagingOutbox(registro.propertyId, registro.organizationId, "email", "staff.email_verification", `email-verification:${registro.staffId}`, {
        to: mensaje.to,
        subject: mensaje.subject,
        html: mensaje.html,
        text: mensaje.text,
      }),
    );
    return true;
  } catch (err) {
    console.error("rentas/onboarding: no se pudo encolar el correo de verificacion:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
