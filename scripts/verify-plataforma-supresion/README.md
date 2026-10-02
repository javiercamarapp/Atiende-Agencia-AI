# verify-plataforma-supresion

Verificación contra Postgres real de `packages/db/migrations/0042_supresion_contacto_plataforma.sql`
(SA-L-46, lista de supresión de plataforma `core.supresion_contacto`). Ver `docs/SUPRESION.md`.

- `run.sh` -- manual, con `initdb`/`pg_ctl`/`psql` locales.
- El gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs`) la descubre sola (tiene `bootstrap.sql`,
  `post-migrations.sql` y `assertions.sql`).

Cubre: registro idempotente solo-sistema, consulta booleana solo-sistema, rechazo de sesión de staff y de anon,
rechazo de valores en claro (el hash debe ser SHA-256 en hex de 64 caracteres), vector de hash compartido con
`apps/api/tests/supresion.spec.ts`, lectura directa de la tabla denegada a todos los roles, superadmin real vs
restringido a finanzas vs staff común vs anon, caller-binding, listado agregado sin valores ni hashes,
"no contactar" manual idempotente, supresión global (cross-tenant) y funciones definer con `search_path` fijo.
