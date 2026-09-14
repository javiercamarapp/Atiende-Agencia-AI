// Fase 11 -- POST /rentas/onboarding/registro: onboarding self-serve del tenant de
// rentas (alta de organización/primera propiedad desde el producto, sin intervención
// manual del equipo de Atiende). Gap real identificado por auditoría -- ver
// @atiende/domain-rentas::RentasOnboardingRepository (packages/domain-rentas/src/
// onboarding/repository.ts) para el detalle completo del bloqueo de plataforma
// (`core.organization`/`core.property`/`core.staff_user`/`core.membership` son
// service_role-write-only, gap ya documentado, con solución conocida vía función
// `security definer` -- mismo patrón que `core.accept_staff_invite`).
//
// PÚBLICA (sin sesión) a propósito -- mismo criterio que
// `POST /rentas/owner-portal/login`/`POST /auth/refresh` (rutas de arranque de sesión
// que por definición corren ANTES de que exista un `auth.uid()` real): usa
// `engine.withAppSession({userId: null}, ...)`, NUNCA `authMiddleware`/`dbSession`.
//
// Esta ruta SOLO valida y bundlea la captura (organización + primera propiedad +
// admin + configuración inicial de rentas) y se la pasa a
// `deps.rentasOnboardingRepo(db).registrarTenant(...)` -- en este monorepo, hoy, esa
// llamada SIEMPRE falla con un error explícito (`notProductionReady`, ver
// apps/api/src/production/rentas-onboarding-repository.ts) porque el puerto no tiene
// todavía un adaptador de producción conectado (gap de plataforma, no de esta ruta).
// La ruta queda lista para funcionar end-to-end el día que ese adaptador se conecte
// -- ejercitada hoy con el adaptador en memoria en
// apps/api/tests/rentas-onboarding.spec.ts.
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
    const body = await readJsonCapped<OnboardingRegistroBody>(c.req.raw, 8 * 1024);

    let captura: CapturaOnboardingRentasValidada;
    try {
      captura = validarCapturaOnboardingRentas(body);
    } catch (err) {
      if (err instanceof RentasDomainError) throw mapRentasDomainError(err);
      throw err;
    }

    // El hash SIEMPRE se calcula, incluso si la escritura de abajo va a fallar por el
    // gap de plataforma (ver comentario de cabecera) -- nunca deja la contraseña en
    // texto plano un instante más de lo necesario, mismo criterio que
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
