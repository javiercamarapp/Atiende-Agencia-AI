# verify-restaurantes-features-viaje-r2

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/077_features_viaje_r2_dia_negocio_cierre_handoff.sql`
(espejo: `supabase/migrations/20240101000377_077_features_viaje_r2_dia_negocio_cierre_handoff.sql`): lote QA R2 de restaurantes
(features-03/05/06/07/08 y viaje-02/04/05/06).

Cubre: `nearest_branch_by_colonia` sin colonias de menos de 3 letras; dia de negocio de la sucursal (la cola de un turno que cruza la medianoche
pertenece al dia en que empezo; excepciones por fecha) y "agotado hasta manana" (no se repone a las 00:00 en pleno turno; alcance por
sucursal y anon); ticket de cocina impreso y aceptacion automatica sin POS (alcance por sucursal, cross-tenant, anon, idempotencia);
`no_recogido` sin hora de recogida; orden estricto del historial de estados dentro de una transaccion; cierre del dia (tiempos de
entregado + completado; `por_aprobar` no es venta); tomas de conversacion PENDIENTES sin tomar (una sola vez, solo sistema);
codigo de compensacion vigente por cliente (solo sistema, por telefono y organizacion, un solo uso).

- Manual: `scripts/verify-restaurantes-features-viaje-r2/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
