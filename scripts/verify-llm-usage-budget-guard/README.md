# verify-llm-usage-budget-guard

Verificación, contra un Postgres **real**, del hallazgo de revisión de PR sobre
`packages/db/migrations/0010_llm_usage_budget_schema.sql` (control de gasto de
API de LLM del back office de plataforma): `core.record_llm_usage`,
`core.reserve_llm_monthly_budget` y `core.settle_llm_monthly_budget` son
`security definer` con `GRANT EXECUTE` a `authenticated` y reciben
`organization_id` como parámetro plano — el comentario de cabecera de la
migración YA decía "solo el backend las invoca, sesión de sistema, JAMÁS desde
una ruta HTTP", pero **nada lo hacía cumplir** dentro de la propia función.

## Qué demuestra

`core` está expuesto por PostgREST (`supabase/config.toml::api.schemas =
["public", "core", ...]`), y el navegador sí recibe un token `authenticated`
de Supabase para funcionalidad en vivo del panel (Realtime). Sin el guard, un
staff de CUALQUIER tenant — o cualquier cliente que sostuviera un JWT
`authenticated` válido — podía invocar estas 3 funciones por RPC directo
(nunca a través de `apps/api`) con la `organization_id` de OTRO tenant:

- `reserve_llm_monthly_budget(<org ajena>, <id>, <monto enorme>)` agota el tope
  MENSUAL de esa organización — o el tope GLOBAL de plataforma, compartido
  entre TODAS las organizaciones — denegación de servicio real del LLM.
- `record_llm_usage(<org ajena>, ...)` infla el gasto reportado de un tenant
  que nunca hizo esas llamadas.
- `settle_llm_monthly_budget` podía liquidar/manipular una reserva ajena.

Este script demuestra, con Postgres real:

1. Una sesión de SISTEMA (`auth.uid()` `NULL`, la única forma real en que el
   backend las invoca — ver `apps/api/src/production/llm-usage-gateway-
   adapters.ts`/`llm-usage-repository.ts`) SÍ puede llamar las 3 funciones
   (nunca se rompió el flujo real del gateway).
2. Cualquier sesión con `auth.uid()` real (staff autenticado, incluso de la
   MISMA organización objetivo) es RECHAZADA con `errcode 42501` — el guard
   bloquea el RPC directo, sin excepción.

## Cómo correrlo

```
scripts/verify-llm-usage-budget-guard/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente, p. ej.
`brew install postgresql@17`). El script levanta un cluster Postgres efímero en
un directorio temporal, aplica las migraciones reales de
`supabase/migrations/` en orden, corre los 6 escenarios de `assertions.sql`, y
apaga/borra el cluster al salir — no toca ningún Postgres existente ni dato
real.

## CI

Este script (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`) corre
en CI automáticamente, en cada PR/push — ver
`.github/workflows/postgres-real-gate.yml` y
`scripts/verify-real-postgres-ci/README.md`. Ese runner ejecuta cada uno de los
6 escenarios de `assertions.sql` como su propia verificación pass/fail (no una
lectura humana de la salida de `psql`), así que si el guard se rompe (o se
relaja) en un cambio futuro, el build falla.

## Por qué no es parte de `npm test`

Mismo motivo que `scripts/verify-outbox-grants/README.md`: este monorepo no
tiene todavía ningún tier de pruebas contra Postgres real dentro de
`npm test`/`vitest` — `InMemoryLlmUsageRepository` (usada por
`npm run test:unit`) nunca aplica `GRANT`/`auth.uid()` reales, así que no puede
detectar este tipo de hueco por diseño. El gate de CI descrito arriba cubre
específicamente este fix sin depender de ese tier general.
