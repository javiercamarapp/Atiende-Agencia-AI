# verify-restaurantes-whatsapp-concurrencia

Verificacion de **concurrencia real** (dos o mas conexiones `psql` simultaneas) del WhatsApp y de los pedidos de
restaurantes, contra un Postgres real con las migraciones reales de `supabase/migrations/`. Rescata del repo original
(`atiende-restaurantes`) `order_idempotency_concurrency.sh`, la prueba de mensajes casi simultaneos del commit `0a346be` y `messaging_outbox_concurrency.sh` (escenario 10).

Por que existe: los tests de `packages/domain-restaurantes` corren contra el repositorio en memoria y
`scripts/verify-restaurantes-sql` ejecuta cada escenario en UNA conexion (la "concurrencia" del escenario 17 es dos llamadas
seguidas). Ninguno prueba que el advisory lock de `create_order_idempotent`, el ledger `claim_whatsapp_message`, el lease
`claim_whatsapp_conversation` y el append atomico `whatsapp_append_turn` aguanten una carrera real.

Garantia de que la carrera es real (mismo patron que `scripts/verify-citas-concurrencia`): una "pistola de salida" (un
controlador retiene un advisory lock exclusivo, los N trabajadores se bloquean en el, se comprueba en `pg_locks` que todos
esperan, y se liberan juntos).

| # | Escenario | Resultado esperado |
|---|---|---|
| 1 | Misma llave y huella, 2 conexiones, 6 rondas | un pedido, mismo id para ambas, `order_count` +1 |
| 2 | Misma llave, 8 conexiones | un pedido, mismo resultado en las 8, `order_count` +1 |
| 3 | Misma llave con contenido distinto, 6 rondas | una crea, la otra `PT409`; una sola fila |
| 4 | Sin llave, misma huella (doble envio) | un pedido pendiente, `order_count` +1 |
| 5 | Llaves distintas del mismo cliente | 2 pedidos, `order_count` +2 (sin actualizacion perdida) |
| 6 | Mismo `message.id` de Meta desde 3 conexiones | exactamente un claim; una fila en el ledger |
| 7 | 3 mensajes distintos del mismo cliente a la vez | exactamente un lease; los otros reintentables |
| 8 | 3 mensajes del mismo cliente anexados en paralelo | el historial conserva los 3 textos |
| 9 | Control negativo | mensajes, clientes y pedidos distintos no se bloquean entre si |
| 10 | Outbox de mensajeria (`claim_messaging_outbox_batch` WhatsApp y `claim_email_outbox_batch` correo), 3-4 conexiones con lotes de 10 y la transaccion abierta 0.4 s | cada fila se reclama exactamente una vez (sin repeticiones entre conexiones), ninguna queda pendiente, las huerfanas con lease vencido se reclaman una sola vez y las de lease vigente no; el reclamo de WhatsApp no toca el correo |

## Uso

```
bash scripts/verify-restaurantes-whatsapp-concurrencia/run.sh          # local: initdb/pg_ctl efimeros
VERIFY_USE_EXISTING_PG=1 bash scripts/verify-restaurantes-whatsapp-concurrencia/run.sh   # CI: servidor ya corriendo
```

Sin `assertions.sql` a proposito: `scripts/verify-real-postgres-ci/run-gate.mjs` auto-descubre solo los `verify-*` de una
conexion. El workflow `.github/workflows/postgres-real-gate.yml` lo invoca en su propio job
(`restaurantes-whatsapp-concurrencia-gate`).

`setup.sql` crea fixtures propios (organizacion, sucursal, 2 clientes) y el esquema `conc` con un envoltorio
`SECURITY INVOKER` (`conc.try_order`) que solo convierte una excepcion en `err:<SQLSTATE>`; no otorga nada nuevo. No toca
ninguna migracion ni la base real.
