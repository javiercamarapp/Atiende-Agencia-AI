# verify-restaurantes-promociones-sucursal

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/038_promociones_por_sucursal.sql`
(espejo: `supabase/migrations/20240101000284_038_*.sql`): `restaurantes.promotions.property_ids uuid[]`
(null = todas las sucursales; lista = solo esas, 1..50).

Cubre positivo (alta y acotado con alcance), los CHECK nuevos (arreglo vacio, mas de 50, limite de 50 aceptado),
compatibilidad hacia atras (INSERT sin la columna deja null; los CHECK de 010 y 031 siguen vigentes), cross-tenant
(insert con organizacion ajena y update ajeno = 0 filas), `anon` (ni inserta ni modifica) y sesion de sistema
(solo ve promociones activas), y el escenario "base sin migrar" (el SQL real que emite el repositorio falla con
42703 y el SAVEPOINT recupera la transaccion).

- Manual: `scripts/verify-restaurantes-promociones-sucursal/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
