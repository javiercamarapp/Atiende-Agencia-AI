// Wiring de producción de `RentasOnboardingRepository` (Fase 11 -- onboarding
// self-serve del tenant de rentas).
//
// Hallazgo de auditoría (severidad CRÍTICA, "el onboarding self-serve de rentas está
// bloqueado en producción") -- CERRADO: antes de este cambio este puerto ENTERO
// resolvía a `notProductionReady` porque `core.organization`/`core.property`/
// `core.staff_user`/`core.membership` (y las tablas de `rentas.*` que completan el
// registro) nunca otorgan escritura a `authenticated`, solo a `service_role` (que
// este monorepo no aprovisiona todavía). Resuelto con `rentas.register_tenant_onboarding`
// (función `security definer`, ver `packages/domain-rentas/migrations/
// 016_onboarding_security_definer.sql`) -- mismo mecanismo exacto que
// `core.accept_staff_invite`: corre con el privilegio del dueño de la función sobre
// la MISMA sesión de sistema que `POST /rentas/onboarding/registro` ya abre
// (`engine.withAppSession({userId: null}, ...)`), sin necesitar `service_role` real.
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { RentasOnboardingRepository } from "@atiende/domain-rentas";
import { PostgresRentasOnboardingRepository } from "@atiende/domain-rentas";

export function createProductionRentasOnboardingRepo(): (db: TenantDbSession) => RentasOnboardingRepository {
  return (db) => new PostgresRentasOnboardingRepository(db);
}
