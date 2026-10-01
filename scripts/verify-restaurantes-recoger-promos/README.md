# verify-restaurantes-recoger-promos

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/031_recoger_promociones_automaticas_puentes.sql`
(espejo: `supabase/migrations/20240101000213_031_*.sql`): `orders.canal|propina|hora_recogida`, los estados
`listo_para_recoger` y `no_recogido`, `create_order_idempotent` (persiste las columnas nuevas y sigue siendo solo
de sistema), `promotions.auto_apply|courtesy_*` (tipo `cortesia`) y `branch_hours_exception` (puentes).

Cubre positivo, rol insuficiente, cross-tenant, `anon`, GRANT por columna y CHECKs.

- Manual: `scripts/verify-restaurantes-recoger-promos/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
