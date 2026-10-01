# verify-restaurantes-kpis-veraces

Prueba contra Postgres real de `packages/domain-restaurantes/migrations/036_kpis_veraces.sql`
(espejo `supabase/migrations/20240101000255_036_restaurantes_kpis_veraces.sql`).

- `assertions.sql` (escenarios juzgados por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI):
  `orders_bucketed_stats` (ventas sin cancelados, clientes por `customer_id` y no por nombre, cross-tenant),
  `orders_channel_stats` y `orders_channel_stats_periodo` (ingresos sin cancelados, ventana de periodo,
  cross-tenant, anon sin acceso a la funcion nueva) y `get_customer_overview_kpis` (ticket promedio sin cancelados).
- `run.sh`: lo mismo contra un Postgres efimero local (`initdb`/`pg_ctl`).
