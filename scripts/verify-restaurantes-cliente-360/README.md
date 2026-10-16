# verify-restaurantes-cliente-360

Prueba contra Postgres real (RLS, GRANT y `auth.uid()` reales) de la migracion
`packages/domain-restaurantes/migrations/049_cliente_360_memoria_domicilios_gustos.sql` (Cliente 360).

Cubre: lectura de la memoria del cliente por la sesion de sistema (`auth.uid()` NULL), cierre idempotente del ciclo
(domicilio y gustos) por pedido, reincidencia de "no recogido" y pedido falso en la ventana, politica configurable
(solo owner/admin), funciones de ficha del staff (rol owner/admin/staff de LA organizacion), exportacion y borrado de
memoria (ARCO), aislamiento cross-tenant, `anon` sin acceso y base sin migrar (42883 recuperable con subtransaccion).

Manual: `scripts/verify-restaurantes-cliente-360/run.sh` (necesita `initdb`/`pg_ctl`/`psql`).
En CI lo corre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (auto-descubrimiento por los tres archivos).
