# verify-staff-2fa

Verificacion contra Postgres REAL (RLS, GRANT, `auth.uid()`) de
`packages/db/migrations/0025_staff_totp_stepup_reset.sql`: segundo factor TOTP, codigos de
respaldo, lockout, anti-replay, cambio/reset de contrasena y verificacion de correo.

Cubre: positivo (la propia cuenta), negativo (formato/vencido/usado), cross-user (otra cuenta
ajena no puede leer, quemar intentos, consumir respaldos, desactivar ni cambiar contrasena),
anon (sin GRANT) y tablas sin acceso directo.

Se ejecuta sola en el gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs` descubre todo
`scripts/verify-*/` con bootstrap + post-migrations + assertions). A mano: `run.sh` (necesita
`initdb`/`pg_ctl`/`psql`).

No cubre: la verificacion criptografica del codigo TOTP (vive en TypeScript, probada contra los
vectores del RFC 6238 en `packages/core-auth/tests/totp.spec.ts`).
