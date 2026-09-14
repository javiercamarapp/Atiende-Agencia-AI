// Puerto de persistencia de la Fase 11 (onboarding self-serve) -- mismo patrón dual
// de adaptador que el resto de domain-rentas (`RentasRepository`/
// `RentasOwnerPortalRepository`): un puerto TS explícito, nunca `TenantDbSession.query`
// crudo expuesto a la ruta HTTP.
//
// GAP DE PLATAFORMA (léase antes de wirear el adaptador Postgres a producción real,
// ver ./postgres-repository.ts para el detalle SQL completo):
//
// `registrarTenant` necesita escribir `core.organization`/`core.property` (crea el
// tenant desde CERO, sin sesión ni membership previos) y `core.staff_user`/
// `core.membership` (el primer admin). Las 4 tablas otorgan
// `insert`/`update`/`delete` SOLO a `service_role` --
// `grant select, insert, update, delete on core.organization, core.property,
// core.staff_user, core.membership to service_role;` (packages/db/migrations/
// 0001_core_schema.sql, línea de grants) -- y este monorepo NO aprovisiona una
// conexión de `service_role` todavía (`ManagedPostgresEngine.admin` es el MISMO rol
// de mínimo privilegio que `withAppSession`, nunca `service_role`; ver el mismo gap ya
// documentado para `rentasOwnerPortalRepo` en
// apps/api/src/production/rentas-owner-portal-repository.ts).
//
// A diferencia de ese gap (3 métodos de un puerto que por lo demás SÍ está completo),
// aquí el puerto ENTERO depende de esas 4 tablas -- no hay una porción "solo lectura"
// que sí funcione. `apps/api/src/production/deps.ts` conecta este puerto a
// `notProductionReady` completo (ver production/rentas-onboarding-repository.ts).
//
// LA SOLUCIÓN REAL YA TIENE PRECEDENTE EN ESTE MISMO MONOREPO -- no es un gap sin
// salida conocida: `core.accept_staff_invite` (`packages/db/migrations/
// 0002_staff_invite_schema.sql`) resuelve EXACTAMENTE este mismo tipo de problema
// (escribir `core.staff_user`/`core.membership` desde un caller SIN sesión
// autenticada todavía) con una función Postgres `security definer` -- corre con el
// privilegio del DUEÑO de la función, no con el de `authenticated`, sin necesitar
// `service_role` como conexión de aplicación. El equivalente para este puerto sería
// una función `core.register_tenant_onboarding(...)` (mismo criterio, ahora también
// sobre `core.organization`/`core.property`) -- y de hecho `core.staff_user.created_via`
// YA reserva el valor `'registro_autoservicio'` desde la migración 0001 sin que
// ningún método lo produzca todavía (ver packages/db/src/core-repository.ts,
// comentario de cabecera). El repo original resolvía este MISMO flujo con el mismo
// mecanismo (`onboarding_registrar_empresa`, `SECURITY DEFINER`, ver
// rentas-standalone/packages/db/src/migrations/0121_onboarding_funciones.ts) --
// confirma que no es una decisión de diseño distinta, es el mismo patrón.
//
// Por qué esta fase NO escribe esa función/migración: `core.organization`/
// `core.property`/`core.staff_user`/`core.membership` son núcleo COMPARTIDO por las 6
// verticales (packages/db/migrations/0001_core_schema.sql, "prerequisito bloqueante
// de cualquier vertical") -- una función `security definer` ahí es una decisión de
// PLATAFORMA (afecta a hoteles/restaurantes/citas/licitaciones/despachos igual que a
// rentas), no del paquete domain-rentas de esta fase. Se documenta la ruta real y
// disponible para cuando esa decisión se tome; no se fuerza aquí.
import type { NuevoTenantRentasInput, ResultadoRegistroTenantRentas } from "./tipos.ts";

export interface RentasOnboardingRepository {
  /** Crea la organización + primera propiedad + primer admin (staff, `platformRole:
   * 'owner'`, `verticalRole:'admin_gestora'`) + configuración inicial de rentas
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
