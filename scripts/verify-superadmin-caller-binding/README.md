# verify-superadmin-caller-binding

Verificación, contra un Postgres **real**, del hallazgo de seguridad corregido
por `packages/db/migrations/0011_superadmin_caller_binding.sql`: las 12
funciones `security definer` del back office de plataforma
(`core.*_for_superadmin`, repartidas en `0010_platform_superadmin.sql`,
`0012_superadmin_prospectos.sql`, `0014_superadmin_demo_access.sql` y las
funciones de back office de `0010_llm_usage_budget_schema.sql`) reciben
`p_caller_id uuid` como parámetro plano y autorizan con
`core.is_platform_superadmin(p_caller_id)` — **sin** atar ese parámetro a
`auth.uid()` (la identidad real de la sesión Postgres que hace la llamada).

## Qué demuestra

`supabase/config.toml::api.schemas = ["public","core","restaurantes","hoteles"]`
expone el schema `core` por PostgREST, y las 12 funciones tienen
`grant execute ... to authenticated`. Antes de este fix, cualquier sesión
`authenticated` (staff de CUALQUIER tenant — no solo el propio superadmin — o
una sesión de sistema con `auth.uid()` NULL, que es justo cómo `apps/api`
las invocaba) podía llamarlas pasando el UUID de un superadmin real como
`p_caller_id` y:

- Leer TODAS las organizaciones de la plataforma
  (`list_all_organizations_for_superadmin`), el "cerebro de ventas" completo
  (`list_prospectos_for_superadmin`) y el gasto/tope real de LLM de cualquier
  organización o de plataforma completa (`get_llm_usage_summary_for_superadmin`
  y las demás de `0010_llm_usage_budget_schema.sql`).
- Escribir en nombre del superadmin suplantado: crear/editar prospectos
  (`create_prospecto_for_superadmin`/`update_prospecto_for_superadmin`),
  ganar membership real en organizaciones demo
  (`ensure_demo_access_for_superadmin`), o fijar el tope mensual de gasto de
  LLM de cualquier organización o de plataforma completa
  (`set_llm_org_monthly_cap_for_superadmin`/
  `set_llm_platform_monthly_cap_for_superadmin`).

El UUID de un superadmin real no es un secreto fuerte (aparece en filas de
auditoría/`creado_por`/membresías, etc.) — la única barrera real era
`core.is_platform_superadmin(p_caller_id)`, que un atacante satisface con
solo CONOCER ese UUID, sin necesitar controlar la cuenta.

Este script demuestra, con Postgres real, 15 escenarios (ver `assertions.sql`
para el detalle exacto de cada uno), cubriendo un representante de LECTURA y
uno de ESCRITURA de cada una de las 4 migraciones fuente:

1. El superadmin real, con **su propia sesión** (`auth.uid()` = su propio id),
   sigue pudiendo hacer todo lo que hacía antes (ningún regreso de
   funcionalidad para el caller legítimo).
2. Un staff **normal y autenticado** (con `auth.uid()` real, pero sin ser
   superadmin) que pasa el UUID de un superadmin como `p_caller_id` es
   RECHAZADO — para las funciones de LECTURA, con 0 filas / el número real
   NUNCA se filtra (se verifica insertando gasto de LLM real y confirmando
   que un caller no autorizado ve `0`, no el valor real); para las de
   ESCRITURA, con `errcode 42501`.
3. Una sesión de **SISTEMA** (`auth.uid()` NULL) que pasa el UUID de un
   superadmin como `p_caller_id` — el patrón EXACTO que `apps/api` usaba
   antes de este fix — también es rechazada. Esto prueba la defensa en
   profundidad a nivel de base de datos de forma independiente de que la capa
   TypeScript esté bien escrita (que también se corrigió, ver
   `apps/api/src/production/core-repository.ts`/`llm-usage-repository.ts`).
4. `anon` no puede ni ejecutar ninguna (sin `GRANT EXECUTE`, confirmado que
   ninguna de las 12 lo tiene).

Las 7 funciones no cubiertas escenario-por-escenario aquí
(`count_staff_by_organization_for_superadmin`,
`update_prospecto_for_superadmin`,
`list_llm_usage_by_organization_for_superadmin`,
`list_llm_usage_by_provider_model_for_superadmin`,
`get_llm_platform_budget_for_superadmin`,
`set_llm_platform_monthly_cap_for_superadmin`) comparten LITERALMENTE el mismo
guard (`auth.uid() is not null and auth.uid() = p_caller_id`) en el mismo
`create or replace` de `0011_superadmin_caller_binding.sql` que las que sí se
prueban aquí — ver ese archivo para la lista completa.

## Cómo correrlo

```
scripts/verify-superadmin-caller-binding/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente, p. ej.
`brew install postgresql@17`). El script levanta un cluster Postgres efímero en
un directorio temporal, aplica las migraciones reales de
`supabase/migrations/` en orden, corre los 15 escenarios de `assertions.sql`, y
apaga/borra el cluster al salir — no toca ningún Postgres existente ni dato
real.

## CI

Este script (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`) corre
en CI automáticamente, en cada PR/push — ver `.github/workflows/postgres-real-gate.yml`
y `scripts/verify-real-postgres-ci/README.md`. Ese runner ejecuta cada uno de
los 15 escenarios de `assertions.sql` como su propia verificación pass/fail (no
una lectura humana de la salida de `psql`), así que si el guard se rompe (o se
relaja) en un cambio futuro, el build falla.

## Por qué no es parte de `npm test`

Mismo motivo que `scripts/verify-llm-usage-budget-guard/README.md`: este
monorepo no tiene todavía ningún tier de pruebas contra Postgres real dentro de
`npm test`/`vitest` — los repositorios en memoria
(`InMemoryCoreRepository`/`InMemoryLlmUsageRepository`, usados por
`npm run test:unit`) nunca aplican `GRANT`/`auth.uid()` reales, así que no
pueden detectar este tipo de hueco por diseño. El gate de CI descrito arriba
cubre específicamente este fix sin depender de ese tier general.

## Fuera de alcance de este fix (documentado, no ignorado)

`core.get_organization_billing_for_checkout(p_caller_id, p_organization_id)`
(`0009_billing_saas_schema.sql`) comparte el MISMO patrón de riesgo
(`security definer` + `grant ... to authenticated` + `p_caller_id` sin atar a
`auth.uid()`, con `core.is_platform_superadmin(p_caller_id)` como una de sus
dos vías de autorización) pero NO es una función del back office de
plataforma — la usa cualquier owner/admin de organización para iniciar
checkout de Stripe, vía `apps/api/src/routes/billing.ts` — así que corregirla
exige además cambiar la sesión de ESA ruta (hoy sesión de sistema) sin
regresionar un flujo de cobro en producción. Se deja fuera de esta migración a
propósito (alcance declarado: "el back office de plataforma") y se reporta
aquí como hallazgo relacionado para una PR de seguimiento dedicada.
