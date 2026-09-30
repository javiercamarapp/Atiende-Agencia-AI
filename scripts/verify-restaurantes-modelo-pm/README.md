# verify-restaurantes-modelo-pm

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/023_modelo_pm_horarios_minimos_zonas_whatsapp_sucursal.sql`
(espejo: `supabase/migrations/20240101000196_023_*.sql`): `branch_policy` (horario / pedido minimo / propina por
sucursal), `products|categories.no_domicilio`, `branch_delivery_zone`, `whatsapp_branch_channel` y la guardia de
unicidad cruzada de `phone_number_id`.

Cubre positivo, rol insuficiente, cross-tenant, `anon`, GRANT por columna, CHECKs y el escenario "base sin migrar"
(el SQL real que emite `PostgresRestaurantesRepository` falla con 42P01/42703 y el SAVEPOINT recupera la transaccion).

- Manual: `scripts/verify-restaurantes-modelo-pm/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
