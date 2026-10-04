# verify-licitaciones-boveda-y-revision

Verificacion contra Postgres REAL (RLS, GRANT por columna, indices unicos, CHECK y `auth.uid()` reales) de
`packages/domain-licitaciones/migrations/037_licitaciones_boveda_matriz_estable_y_revision.sql`
(L-P3-05/06/07: boveda de documentos de la convocatoria, matriz de requisitos estable, conflictos persistidos
y comentarios de revision).

Cubre: la bitacora con las acciones nuevas (y rechazo de una desconocida); el escritor real de `tender_document` (positivo con version nueva; viewer, anon, cross-tenant,
blob ajeno, `uploaded_by` ajeno, tipo invalido y update/delete negados); upsert estable de `requirement_item`
(clave estable unica entre activos; un retirado libera la clave); conflictos (resolver exige notas, solo uno
mismo como `resolved_by`, cross-tenant, anon, sin delete, huella unica); comentarios de revision (autor =
sesion, solo de adicion, cross-tenant, viewer, anon, alcance consistente).

- Gate de CI (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-boveda-y-revision/run.sh`.
