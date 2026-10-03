# verify-superadmin-cerebro

Verificación contra Postgres real de `packages/db/migrations/0049_cerebro_ventas_base.sql`
(SA-L-37 modelo de datos, SA-L-38 taxonomía por vertical, SA-L-41 persistencia del scoring).

- `run.sh` -- manual, con `initdb`/`pg_ctl`/`psql` locales.
- El gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs`) lo descubre solo (tiene `bootstrap.sql`,
  `post-migrations.sql` y `assertions.sql`).

Cubre: columnas y CHECKs nuevos de `core.prospecto` (base de licitud con contacto, consentimiento, coordenadas, scores
0-100, duplicado propio), filas previas marcadas `contacto_legado`, persona de contacto (evidencia http(s) obligatoria,
origen de lista cerrada: un correo deducido por patrón no se guarda; exige base de licitud del prospecto), evento de
cambio de etapa, taxonomía versionada (semilla de 6 verticales marcada propuesta, editar crea versión nueva, rechazo de
promesas de cifras, plan de otra vertical, precio leído de `core.plan`), caller-binding, staff común, superadmin de
finanzas, anon, tablas sin acceso directo y funciones definer con `search_path` fijo.
