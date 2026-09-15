// Puerto de persistencia de la Fase 11 (onboarding self-serve) -- mismo patrón dual
// de adaptador que el resto de domain-rentas (`RentasRepository`/
// `RentasOwnerPortalRepository`): un puerto TS explícito, nunca `TenantDbSession.query`
// crudo expuesto a la ruta HTTP.
//
// GAP DE PLATAFORMA -- CERRADO (hallazgo de auditoría, severidad CRÍTICA, "el
// onboarding self-serve de rentas está bloqueado en producción"). Léase primero el
// comentario de cabecera de `packages/domain-rentas/migrations/
// 016_onboarding_security_definer.sql` para el detalle SQL completo; resumen aquí:
//
// `registrarTenant` necesita escribir `core.organization`/`core.property` (crea el
// tenant desde CERO, sin sesión ni membership previos), `core.staff_user`/
// `core.membership` (el primer admin), y las tablas de `rentas.*` que completan el
// registro (`organization_perfil`/`property_config`/`owner`/`owner_organization`/
// `unidad`) -- NINGUNA de esas tablas otorga `insert`/`update`/`delete` a
// `authenticated`, solo a `service_role` (que este monorepo no aprovisiona todavía,
// `ManagedPostgresEngine.admin` es el MISMO rol de mínimo privilegio que
// `withAppSession`). Resuelto con el MISMO mecanismo que ya usa
// `core.accept_staff_invite` (`packages/db/migrations/0002_staff_invite_schema.sql`)
// para el mismo tipo de problema (escribir desde un caller SIN sesión autenticada
// todavía): una función Postgres `security definer`
// (`rentas.register_tenant_onboarding`, migración 016) que corre con el privilegio
// del DUEÑO de la función, sin necesitar `service_role` como conexión de aplicación.
// `PostgresRentasOnboardingRepository.registrarTenant` (./postgres-repository.ts) es
// una sola llamada a esa función; `apps/api/src/production/
// rentas-onboarding-repository.ts` deja de conectar este puerto a
// `notProductionReady`.
import type { NuevoTenantRentasInput, ResultadoRegistroTenantRentas } from "./tipos.ts";

export interface RentasOnboardingRepository {
  /** Crea la organización + primera propiedad + al menos una unidad
   * (`input.primerasUnidades`) + primer admin (staff, `platformRole:'owner'`,
   * `verticalRole:'admin_gestora'`) + configuración inicial de rentas
   * (`rentas.organization_perfil`/`rentas.property_config`, y `rentas.owner` +
   * `rentas.owner_organization` si `input.primerOwner` viene presente) EN UNA SOLA
   * escritura atómica. `input.organizacion.slugPropuesto` es un candidato -- si ya
   * existe, el adaptador debe resolver la colisión (sufijo numérico incremental,
   * nunca fallar el registro completo por un choque de slug) y devolver el slug
   * REAL que terminó asignado. Lanza `RentasDomainError('onboarding_datos_invalidos'
   * | 'onboarding_organizacion_duplicada', ...)` si el correo del admin ya existe
   * (`core.staff_user.email` es `unique`) -- nunca deja que un `unique_violation`
   * crudo de Postgres llegue a la ruta HTTP. */
  registrarTenant(input: NuevoTenantRentasInput): Promise<ResultadoRegistroTenantRentas>;
}
