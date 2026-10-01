# verify-restaurantes-pedidos-programados

Prueba contra Postgres real de `packages/domain-restaurantes/migrations/034_pedidos_programados.sql`
(espejo `supabase/migrations/20240101000239_034_pedidos_programados.sql`).

- `assertions.sql` (24 escenarios, juzgados por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI):
  creacion de un pedido `programado` por `create_order_idempotent` (positivo, hora pasada rechazada,
  idempotencia con y sin llave, solo sistema, anon), CHECKs de `orders`, `promover_pedidos_programados`
  (promueve vencidos y dentro de la anticipacion, idempotente, un cancelado o lejano no se promueve, staff
  ignora el reloj que manda, alcance por sucursal, barrido global solo de sistema, cross-tenant, anon) y
  cancelacion/lectura cross-tenant.
- `run.sh`: lo mismo contra un Postgres efimero local (`initdb`/`pg_ctl`).
