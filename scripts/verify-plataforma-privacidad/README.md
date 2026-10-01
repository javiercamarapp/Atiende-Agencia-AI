# verify-plataforma-privacidad

Verificación contra Postgres real de `packages/db/migrations/0036_plataforma_arco_retencion_aviso.sql`
(privacidad de plataforma: ARCO unificado, retención por organización, bloqueo y registro de purgas, aviso versionado).
Ver `docs/PRIVACIDAD-PLATAFORMA.md`.

- `run.sh` -- manual, con `initdb`/`pg_ctl`/`psql` locales.
- El gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs`) la descubre sola (tiene `bootstrap.sql`,
  `post-migrations.sql` y `assertions.sql`).

Cubre: owner/admin vs member, cross-tenant, superadmin real vs restringido a finanzas, caller-binding, anon,
sesión de sistema, rangos de retención, bloqueo previo a purga, protección de titulares con ARCO abierta, registro
sin PII, append-only, tablas sin acceso directo y funciones definer con `search_path` fijo.
