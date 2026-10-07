# verify-licitaciones-dedupe-y-paginacion

Verificacion contra Postgres REAL (RLS, GRANT, trigger, funcion `security definer` de solo-sistema y `auth.uid()` reales) de
`packages/domain-licitaciones/migrations/037_licitaciones_huella_cruzada_entre_fuentes.sql` (paridad3 L-P3-14: huella cruzada
entre fuentes) y de las consultas de listado/conteo de `postgres-repository.ts` (paridad3 L-P3-13).

Cubre: vectores dorados de la huella (los mismos que `packages/domain-licitaciones/tests/cross-source-fingerprint.spec.ts`: la
implementacion TypeScript y la SQL deben coincidir), normalizacion y zona horaria de Mexico, huella nula sin dato suficiente,
trigger que sobrescribe cualquier huella enviada por un cliente, backfill de convocatorias manuales, ingesta de sistema que ENLAZA
la segunda fuente en vez de duplicar (con conflictos registrados, sin sobrescribir), idempotencia, la misma huella en otra
organizacion NO se enlaza (cross-tenant), la funcion solo corre sin `auth.uid()` y rechaza `manual`, RLS de
`tender_alt_source` (solo select de la propia organizacion; sin insert/update/delete para authenticated; anon sin nada), el indice
parcial de la huella y, con 251 convocatorias, el orden total de la pagina (sin repetir ni saltar con el mismo `updated_at`) y los
conteos del resumen.

- Gate de CI (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-dedupe-y-paginacion/run.sh`.
