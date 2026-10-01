# verify-citas-data-rights

Verificacion contra Postgres REAL (RLS, GRANT por columna y `auth.uid()` reales) de
`packages/domain-citas/migrations/024_citas_data_rights.sql` (solicitudes ARCO de
citas). El repositorio en memoria de `domain-citas` no aplica RLS ni GRANT, asi que
solo esta prueba puede detectar un hueco de autorizacion.

Cubre: registro de sistema idempotente, confirmacion/retiro por el titular con
plazos de 20 + 15 dias, aislamiento por telefono y por organizacion, expiracion a
las 24 h, actualizacion de estado solo por owner/admin (cross-tenant, rol `staff`,
sistema y anon rechazados), transiciones validas e invalidas, lectura por RLS,
escritura directa denegada, bitacora append-only y el SQLSTATE real (42883/42P01)
de una base sin migrar recuperado con SAVEPOINT.

Los escenarios negativos usan `verify_support.expect_sqlstate`, que exige el SQLSTATE
exacto (un error cualquiera no basta).

Uso manual: `scripts/verify-citas-data-rights/run.sh` (requiere initdb/pg_ctl/psql).
En CI lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs`
(contrato de 3 archivos: bootstrap.sql + post-migrations.sql + assertions.sql).

No es asesoria legal: los plazos son una referencia operativa conservadora.
