// Wiring de producción de `RentasOnboardingRepository` (Fase 11 -- onboarding
// self-serve del tenant de rentas). A diferencia de `ProductionRentasOwnerPortalRepository`
// (3 de 8 métodos bloqueados, el resto SÍ corre sobre la sesión RLS por-request
// normal), aquí el puerto ENTERO depende de escribir `core.organization`/
// `core.property`/`core.staff_user`/`core.membership`, que NUNCA otorgan
// insert/update/delete a `authenticated` (packages/db/migrations/0001_core_schema.sql)
// -- no hay ninguna porción de este puerto que funcione hoy contra la sesión RLS
// normal, así que se conecta a `notProductionReady` completo, sin una clase
// delegadora intermedia (no hay nada que delegar).
//
// La ruta real y disponible para cerrar este gap está documentada en
// @atiende/domain-rentas::onboarding/repository.ts (y su adaptador SQL real, correcto
// y sin mocks, en onboarding/postgres-repository.ts): una función Postgres
// `security definer` (`core.register_tenant_onboarding`, mismo patrón que
// `core.accept_staff_invite`, packages/db/migrations/0002_staff_invite_schema.sql) --
// eso es trabajo de PLATAFORMA (una función en el esquema `core`, compartido por las
// 6 verticales), fuera del alcance de este paquete de dominio/esta fase.
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { RentasOnboardingRepository } from "@atiende/domain-rentas";
import { notProductionReady } from "./not-ready.ts";

export function createProductionRentasOnboardingRepo(): (db: TenantDbSession) => RentasOnboardingRepository {
  return (_db) =>
    notProductionReady<RentasOnboardingRepository>(
      "rentasOnboardingRepo (requiere una función security definer en core.* o una sesión de service_role -- ver @atiende/domain-rentas::onboarding/repository.ts y apps/api/src/production/rentas-onboarding-repository.ts)",
    );
}
