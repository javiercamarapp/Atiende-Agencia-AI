// Rn-36 -- GET /v1/rentas/:propertyId/admin/onboarding: checklist de onboarding de la organizacion de rentas, calculado con datos
// reales (feeds iCal, tarifas base, reglas de comision, politica de acceso, staff, propietarios y plantillas aprobadas). Copia el
// patron de restaurantes/admin-onboarding.ts (R-33):
//   - Solo lectura: un GET NUNCA emite notificaciones ni escribe nada (bloqueante que el revisor encontro en #319).
//   - Es de TODA la organizacion: solo lo ve admin_gestora (STAFF_INVITE_ROLES) cuya membership no esta acotada a algunas
//     propiedades; una membership acotada responde 403 (no se le revela el estado de propiedades que no administra).
// Base sin migrar: cada medicion degrada con SAVEPOINT a "no disponible" (ver PostgresRentasOnboardingChecklistRepository); el staff
// vive en `core` y se mide aqui con el mismo respaldo. Nunca hay 500 por una migracion pendiente.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { PostgresRentasOnboardingChecklistRepository, STAFF_INVITE_ROLES, calcularChecklistOnboardingRentas } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

function esDegradable(err: unknown): boolean {
  return isMigrationPendingError(err) || (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "42501");
}

export function rentasAdminOnboardingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/rentas/:propertyId/admin/onboarding";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    const db = c.get("db");

    // El checklist es de TODA la organizacion: una membership acotada a algunas propiedades no lo ve.
    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    const membership = memberships.find((m) => m.organizationId === organizationId);
    // Sin la membership completa (no deberia pasar) se asume el alcance mas estrecho: la unica propiedad ya verificada.
    const alcance: readonly string[] | null = membership ? membership.propertyIds : [c.req.param("propertyId")];
    if (alcance !== null) throw Errors.forbidden("El checklist de onboarding es de toda la organización: requiere acceso a todas las propiedades.");

    const repo = deps.rentasOnboardingChecklistRepo ? deps.rentasOnboardingChecklistRepo(db) : new PostgresRentasOnboardingChecklistRepository(db);
    const datos = await repo.cargar(organizationId);
    const staffRepo = deps.coreStaffRepo(db);
    const staff = await runWithSavepointFallback({
      session: db,
      primary: async () => {
        const miembros = await staffRepo.listOrgMembers(organizationId);
        const invitaciones = await staffRepo.listPendingStaffInvites(organizationId);
        return { miembros: miembros.length, invitacionesPendientes: invitaciones.length };
      },
      isRecoverable: esDegradable,
      fallback: async () => null,
    });

    c.header("Cache-Control", "no-store");
    return c.json(calcularChecklistOnboardingRentas({ ...datos, staff }));
  });

  return app;
}
