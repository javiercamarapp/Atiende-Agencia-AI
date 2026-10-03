# verify-whatsapp-plantillas-optout (PL-31 / PL-32)

Verificacion contra Postgres REAL de la migracion `packages/db/migrations/0049_whatsapp_plantillas_y_alta_supresion.sql`:
catalogo `core.whatsapp_plantilla` (RLS owner/admin, GRANT por columna, CHECKs, marcas de estado), funciones solo-sistema
`core.whatsapp_plantilla_resolver` / `core.whatsapp_plantilla_aprobada`, ALTA de la lista de supresion
(`core.reactivar_supresion_baja`) y `citas.ultimo_mensaje_entrante`. Escenarios positivos, negativos, cross-tenant
(A contra B), staff (42501), anon y validaciones (22023, 23514). Ver `assertions.sql`.

- Manual: `scripts/verify-whatsapp-plantillas-optout/run.sh` (requiere `initdb`/`pg_ctl`/`psql`; usa un cluster efimero).
- CI: `scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio automaticamente (bootstrap.sql + post-migrations.sql + assertions.sql).
