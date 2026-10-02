# verify-rentas-pricing-edicion

Verificación contra Postgres real de
`packages/domain-rentas/migrations/030_rentas_pricing_borrado_politicas.sql` (Rn-23: editar y borrar la
configuración de precios de una unidad: policies y GRANT de DELETE para temporada, descuento por
duración y min-stay; la tarifa base conserva su historial).

Se auto-descubre en CI (`scripts/verify-real-postgres-ci/run-gate.mjs`); a mano:
`scripts/verify-rentas-pricing-edicion/run.sh` (requiere `initdb`/`pg_ctl`/`psql`).

18 escenarios en `assertions.sql`: admin_gestora edita/borra (1-6), tarifa base sin DELETE (7), roles sin
escritura (8-11), cross-tenant (12-15), admin acotado a otra property (16), anon y sistema (17-18).
