# verify-restaurantes-softrestaurant-outbox

Verificacion, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/024_softrestaurant_comanda_outbox.sql`
(bandera por organizacion + outbox de comandas hacia SoftRestaurant). El
repositorio en memoria nunca aplica RLS ni GRANT, asi que solo esto puede
detectar un hueco de autorizacion.

## Que demuestra (64 escenarios)

- **A) Bandera**: owner/admin la cambian; staff, repartidor, otra organizacion,
  la sesion de sistema y anon NO. Sin fila => `apagado` (default). Lectura
  cross-tenant rechazada; `updated_by` no es legible (GRANT por columna).
- **B) Encolar**: solo la sesion de sistema; idempotente por pedido; rechaza un
  pedido de otra organizacion o una sucursal que no corresponde; payload acotado.
- **C) Reclamar/completar**: solo sistema; la bandera `apagado` es un interruptor
  de emergencia; backoff respetado; lease vencido en el ultimo intento pasa a
  captura manual; una comanda `confirmada` exige folio y un folio solo puede
  existir en una `confirmada`.
- **D) Captura manual**: owner/admin/staff con acceso a la sucursal; nunca sobre una
  comanda en vuelo o ya confirmada; corta los reintentos automaticos.
- **E) Lectura y escritura directa**: staff ve solo sus sucursales, repartidor y
  otras organizaciones no ven nada; `idempotency_key`/`reclamada_en` ocultas;
  INSERT/UPDATE/DELETE directos rechazados para todos.

## Como correrlo

```
scripts/verify-restaurantes-softrestaurant-outbox/run.sh   # Postgres efimero local
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-softrestaurant-outbox
```

El gate de CI (`.github/workflows/postgres-real-gate.yml`) lo descubre solo porque
tiene `bootstrap.sql` + `post-migrations.sql` + `assertions.sql`.
