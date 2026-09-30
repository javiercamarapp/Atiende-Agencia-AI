# verify-licitaciones-source-run-check

Verifica contra Postgres real la migracion `packages/domain-licitaciones/migrations/028_source_run_check_yucatan_guadalajara.sql`
(espejo `supabase/migrations/20240101000189_...`): el CHECK de `licitaciones.source_run.source` ahora admite
`yucatan_ocds` y `guadalajara_ocds`, y el comportamiento contra el esquema SIN migrar (se recrea el CHECK de la
migracion 023 dentro de la transaccion del escenario) recupera el 23514 con SAVEPOINT conservando los tenders.

- Manual: `scripts/verify-licitaciones-source-run-check/run.sh` (requiere initdb/pg_ctl/psql).
- CI: `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo (bootstrap + post-migrations + assertions).
