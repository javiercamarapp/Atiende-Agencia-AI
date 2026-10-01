# verify-licitaciones-kyc-69b

Verificacion contra Postgres REAL (RLS, GRANT por columna, funciones `security definer` y `auth.uid()`
reales) de `packages/domain-licitaciones/migrations/031_licitaciones_kyc_69b.sql` (L-08: KYC negativo
contra la lista 69-B del SAT para proveedores y competidores).

Cubre: consulta de un RFC o lote contra la edicion VIGENTE (dos ediciones de fixture, RFC ficticios),
las cuatro situaciones con su fecha de publicacion, RFC invalido / generico / lote de 51 / vacio / NULL,
tope diario por organizacion, bitacora privada por organizacion (cross-tenant, viewer, writer, sistema,
otra vertical), anon, escritura directa denegada, tablas de despachos cerradas, fichas (RLS, GRANT por
columna, unicidad, tope de 500) y el semaforo de la cartera.

- Gate de CI (automatico, lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs`): sin pasos extra.
- A mano contra un Postgres local efimero: `scripts/verify-licitaciones-kyc-69b/run.sh`.
