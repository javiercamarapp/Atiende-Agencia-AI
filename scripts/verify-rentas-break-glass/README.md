# verify-rentas-break-glass

Verificación, contra un Postgres **real**, de
`packages/domain-rentas/migrations/018_break_glass_wiring.sql`: cierra el gap
de la auditoría del 18-sep-2026 ("break-glass de superadmin construido pero
desconectado de toda ruta HTTP") y corrige, de paso, el criterio débil de
`rentas.is_platform_superadmin` que esa misma auditoría dejó pasar.

## Qué demuestra

1. **Criterio de superadmin corregido.** `rentas.is_platform_superadmin` ya
   NO cuenta "un `core.staff_user` que existe y no tiene ninguna
   `core.membership`" como superadmin (el criterio de
   `012_break_glass_audit.sql`, documentado ahí mismo como un proxy débil).
   Ahora delega en `core.platform_superadmin` (la tabla real de roles de
   plataforma, ya atada a `auth.uid()` por `0012_caller_binding_fase2.sql`).
   Un staff recién creado, invitado sin aceptar, o al que le quitaron sus
   membresías YA NO puede abrir ni leer break-glass solo por carecer de
   membership — los escenarios 1/3/5/17 lo demuestran con un staff real, sin
   ninguna fila en `core.membership` y sin alta en `core.platform_superadmin`.
2. **Las 4 funciones nuevas** (`open_break_glass_session`/
   `list_break_glass_sessions_for_superadmin`/`close_break_glass_session`/
   `list_reservas_for_break_glass`) exigen `auth.uid() = p_caller_id` +
   `rentas.is_platform_superadmin(p_caller_id)` — mismo patrón que
   `core.*_for_superadmin` (`0011_superadmin_caller_binding.sql`). Un staff
   normal, un staff sin membresías, una sesión de SISTEMA (el patrón que
   `apps/api` usaba ANTES del PR #127) y `anon` son rechazados por igual.
3. **Acceso acotado en el tiempo.** `list_reservas_for_break_glass` solo
   devuelve datos del tenant mientras exista una `rentas.break_glass_session`
   VIGENTE (sin cerrar, sin vencer) para el mismo actor+organización —
   escenarios 11/12/13: sin ninguna ventana, con una vencida, y con una
   activa real (que sí devuelve la reserva de fixture).
4. **`rentas.break_glass_access_log` sigue siendo append-only** (ver
   `012_break_glass_audit.sql`): ni UPDATE ni DELETE, para nadie, ni siquiera
   `service_role` — escenarios 20/21, verificados de nuevo aquí porque esta
   fase es la primera vez que el mecanismo queda alcanzable por una ruta HTTP
   real.
5. **Visibilidad del tenant.** `admin_gestora` de la organización afectada ve
   tanto las ventanas de acceso (`break_glass_session`) como la bitácora
   (`break_glass_access_log`) abiertas contra SU organización — escenarios
   24/25.

25 escenarios en total (ver `assertions.sql` para el detalle exacto de cada
uno) — cada uno corre en su propio `begin; ... rollback;`; las fixtures (2
superadmins reales, 1 staff sin membresías, 1 staff con membership real, 3
ventanas de acceso en 3 estados distintos, 1 fila de bitácora, 1 reserva real)
persisten (insertadas directo, como el superusuario que corre el script).

## Cómo correrlo

```
scripts/verify-rentas-break-glass/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente, p.
ej. `brew install postgresql@17`). El script levanta un cluster Postgres
efímero en un directorio temporal, aplica las migraciones reales de
`supabase/migrations/` en orden, corre los 25 escenarios de
`assertions.sql`, y apaga/borra el cluster al salir — no toca ningún Postgres
existente ni dato real.

## CI

Este script (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`) corre
en CI automáticamente, en cada PR/push — ver `.github/workflows/postgres-real-gate.yml`
y `scripts/verify-real-postgres-ci/README.md`. Ese runner descubre
`scripts/verify-*/` automáticamente (no hace falta registrarlo en ningún
lado) y ejecuta cada uno de los 25 escenarios como su propia verificación
pass/fail — si el guard se rompe (o se relaja) en un cambio futuro, el build
falla.

## Por qué no es parte de `npm test`

Mismo motivo que `scripts/verify-superadmin-caller-binding/README.md`: este
monorepo no tiene todavía ningún tier de pruebas contra Postgres real dentro
de `npm test`/`vitest` — los repositorios en memoria
(`InMemoryBreakGlassSessionRepository`/`InMemoryBreakGlassAuditRepository`/
`InMemoryBreakGlassRentasDataRepository`, usados por `npm run test:unit`)
nunca aplican RLS/`GRANT`/`auth.uid()` reales, así que no pueden detectar este
tipo de hueco por diseño (de hecho, el hallazgo del comentario de
`packages/domain-rentas/src/break-glass/postgres-data-repository.ts` — que
`ManagedPostgresEngine.admin` NO bypassa RLS en este monorepo — solo era
detectable así, nunca por la suite en memoria). El gate de CI descrito arriba
cubre específicamente este fix sin depender de ese tier general.

## Hallazgo adicional corregido en el mismo pase

Documentado aquí porque no es solo el criterio de superadmin: la lectura de datos de tenant
(`PostgresBreakGlassRentasDataRepository.listReservasTenant`) estaba
diseñada para correr sobre `ManagedPostgresEngine.admin` — verificado contra
el código real (`apps/api/src/production/deps.ts`, comentario explícito:
"la confirmación de que `engine.admin` NO es `service_role`") que ese rol
sigue sujeto a las policies normales de `rentas.ocupacion` (solo staff con
membership real); el mecanismo, tal como estaba, SIEMPRE habría devuelto
cero filas contra Postgres real, sin importar quién llamara. Se corrigió con
`rentas.list_reservas_for_break_glass`, una función `security definer` que
corre sobre la MISMA sesión del superadmin — mismo patrón que
`013_owner_portal_security_definer.sql` ya estableció para el mismo tipo de
gap. El escenario 13 de este script es la prueba de que la lectura real
ahora sí funciona.

## Fuera de alcance de este fix (documentado, no ignorado)

- **Lecturas más allá de `reservas`.** El dominio (`packages/domain-rentas/src/
  break-glass/tipos.ts`, comentario de `BreakGlassReservaResumen`) previó
  categorías adicionales (`finanzas`, `owner_statements`, `payouts`,
  `pricing`, `mensajeria`, `limpieza`, `sync_ical`) como `resourceType`
  válidos en la bitácora, pero solo `reservas` tiene hoy un lector concreto
  (`leerReservasTenantBreakGlass`/`rentas.list_reservas_for_break_glass`).
  Agregar cada categoría adicional es una extensión de este mismo mecanismo
  (nueva función `security definer` + nuevo método de
  `BreakGlassRentasDataRepository`), no un rediseño — se deja para una PR de
  seguimiento dedicada cuando exista un caso de uso real que la pida (mismo
  criterio de "un flujo a la vez" que ya documenta `data-repository.ts`).
- **Alcance por propiedad.** `resourceScope` (jsonb, p. ej.
  `{"propertyId": "..."}`) viaja tal cual a la bitácora, pero
  `list_reservas_for_break_glass` no lo usa todavía para filtrar — lee TODO
  el tenant. Acotar por propiedad es una extensión del mismo lector, no un
  cambio de esquema.
