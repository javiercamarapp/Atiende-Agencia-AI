# verify-restaurantes-voz-huerfanas

Verificacion contra Postgres REAL (RLS, GRANT y `auth.uid()` reales, nunca el repositorio en memoria) de
`packages/domain-restaurantes/migrations/060_voz_cerrar_huerfanas.sql`: la funcion de sistema que cierra como `abandonado` las
llamadas de voz que quedaron abiertas para siempre (el worker murio antes de llamar a `/cerrar`).

Cubre: cierre con duracion/costo/p95 correctos, llamadas recientes y ya cerradas intactas, previews, lote acotado, idempotencia,
KPI (`voz_kpis_diarios`) que ya cuenta la llamada como abandonada, rechazo de usuarios autenticados (42501), `anon` (42501) y
parametros fuera de rango (22023).

Se corre solo en el gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio) o a mano con `./run.sh`
(requiere `initdb`/`pg_ctl`/`psql` locales).
