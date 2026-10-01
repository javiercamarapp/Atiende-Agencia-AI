# verify-staff-sessions

Verificacion contra Postgres REAL (RLS, GRANT, `auth.uid()`) de
`packages/db/migrations/0033_staff_sessions_y_google_vinculo.sql`: sesiones activas del staff
(registrar al emitir, listar, cerrar una a una) y listar/desvincular identidades de Google.

Cubre: positivo (la propia cuenta), negativo (otra cuenta ajena no puede listar ni cerrar), cross-user
(rotacion con el jti de otra cuenta, desvincular el Google de otra cuenta), anon (sin GRANT), la tabla
sin acceso directo, solo-sistema para registrar, rotacion que hereda `started_at`, corte masivo,
expiracion, revocacion por logout y el tope de 50 sesiones vivas por cuenta.

Se ejecuta sola en el gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs` descubre todo
`scripts/verify-*/` con bootstrap + post-migrations + assertions). A mano: `run.sh` (necesita
`initdb`/`pg_ctl`/`psql`).
