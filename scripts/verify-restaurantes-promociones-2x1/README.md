# verify-restaurantes-promociones-2x1

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/027_promociones_2x1_y_canal.sql`
(espejo: `supabase/migrations/20240101000208_027_*.sql`): `restaurantes.promotions` acepta `type = 'bogo'`
(2x1, `value = 1`), `channels` (domicilio|recoger) y `product_ids` (<= 50).

Cubre positivo, CHECKs (bogo con value distinto de 1, canal inexistente o vacio, mas de 50 productos, type
desconocido, los CHECK de la 010 siguen vigentes), cross-tenant (insert con organizacion ajena y update
ajeno = 0 filas), `anon` (ni lee ni escribe) y sesion de sistema (solo resuelve activas), `increment_promotion_uses` con un 2x1
y el escenario "base sin migrar" (el SQL real que emite `PostgresRestaurantesRepository` falla con 42703 y
el SAVEPOINT recupera la transaccion).

- Manual: `scripts/verify-restaurantes-promociones-2x1/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
