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
import { Hono } from "hono";
import { hashPassword } from "@atiende/db";
import { validarCapturaOnboardingRentas, RentasDomainError } from "@atiende/domain-rentas";
import type { CapturaOnboardingRentasValidada } from "@atiende/domain-rentas";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { mapRentasDomainError } from "./reservas.ts";

interface OnboardingRegistroBody {
  readonly admin?: { readonly password?: unknown };
}

export function rentasOnboardingRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/rentas/onboarding/registro", async (c) => {
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

    return c.json(resultado, 201);
  });

  return app;
}
