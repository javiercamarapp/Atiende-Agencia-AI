# verify-restaurantes-sucursal-directorio

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/057_sucursal_directorio_y_domicilio.sql`
(espejo: `supabase/migrations/20240101000332_057_*.sql`): columnas `visible_en_directorio`, `acepta_domicilio`,
`dias_domicilio` y `de_temporada` de `restaurantes.branch_policy`, y (escenarios F) `solo_venta_local` de
`packages/domain-restaurantes/migrations/105_sucursal_solo_venta_local.sql` (espejo `supabase/migrations/20240101000610_105_*.sql`).

Cubre positivo (owner/admin), rol insuficiente (staff), cross-tenant (escritura y lectura), `anon` (sin lectura ni
escritura), GRANT por columna (`organization_id` no se mueve), CHECKs de `dias_domicilio`, defaults que conservan el
comportamiento anterior, lectura de la sesion de sistema del storefront y el escenario "base sin migrar" (42703 y
SAVEPOINT recupera la transaccion).

- Manual: `scripts/verify-restaurantes-sucursal-directorio/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
