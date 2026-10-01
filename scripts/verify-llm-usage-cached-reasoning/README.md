# verify-llm-usage-cached-reasoning

Verifica contra Postgres real la migración `packages/db/migrations/0040_llm_usage_tokens_cached_reasoning.sql`
(espejo `supabase/migrations/20240101000260_...`):

- `core.record_llm_usage` acumula `tokens_cached` y `tokens_reasoning` (escenarios 1-3).
- Compatibilidad: la llamada de 10 argumentos del código anterior sigue funcionando (4); los negativos no restan (5).
- El CHECK de `vertical` admite `superadmin`, `plataforma` y `reportes` (6) y rechaza una vertical inventada (7).
- Seguridad: staff con sesión real de otra organización (8) y `anon` (9) son rechazados; `authenticated` no lee la
  tabla directo (10).

Local: `scripts/verify-llm-usage-cached-reasoning/run.sh` (Postgres efímero con initdb). En CI lo descubre
`scripts/verify-real-postgres-ci/run-gate.mjs` (cualquier `verify-*/` con los 3 archivos).
