# verify-hoteles-housekeeping-dia (H-P3-04)

Verifica contra Postgres real la sección 4 de `packages/domain-hoteles/migrations/045_hoteles_folio_cierre_carrera.sql`:
columna `housekeeping_config.start_hour` (CHECK 0..23, GRANT de columna), ledger `housekeeping_day_run` (RLS, sin escritura directa)
y las funciones de SOLO SISTEMA `system_hk_*` que usa el cron `housekeeping-dia` (idempotencia por (property, fecha), opt-out, fuera
de servicio, asignación con guarda de estado, aislamiento entre properties/tenants, anon).

- `assertions.sql`: 24 escenarios, una conexión cada uno (los auto-descubre `scripts/verify-real-postgres-ci/run-gate.mjs` en CI).
- `run.sh`: lo mismo contra un Postgres efímero local (`initdb`/`pg_ctl`/`psql`).
