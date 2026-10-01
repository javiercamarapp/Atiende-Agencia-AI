# verify-licitaciones-dias-inhabiles

Verificacion contra Postgres REAL (RLS, GRANT por columna, trigger de sello, funcion `security definer`
de solo-sistema y `auth.uid()` reales) de `packages/domain-licitaciones/migrations/032_licitaciones_dias_inhabiles.sql`
(L-22: calendario de dias inhabiles por organizacion y por convocatoria).

Cubre: lectura por miembros de la propia organizacion (y nunca de otra), declarar un dia (solo
owner/admin/analyst: writer y viewer denegados), `created_by` forzado a `auth.uid()`, convocatoria de
otra organizacion rechazada, unicidad del dia vigente por alcance, soft delete sellado por el trigger
(`eliminado_por` no falsificable, no se reabre, no hay DELETE), anon sin ningun privilegio, GRANT por
columna (no se escribe `id`, `created_at` ni `eliminado_por`) y la funcion de solo-sistema (sin
`auth.uid()` devuelve solo los dias de la organizacion pedida; con `auth.uid()` falla; anon sin EXECUTE).

- Gate de CI (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-dias-inhabiles/run.sh`.
