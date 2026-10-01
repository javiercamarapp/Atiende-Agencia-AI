# verify-data-chat

Verifica contra **Postgres real** (RLS + GRANT + `auth.uid()` reales) las dos piezas de SQL de
"Chatea con tus datos":

- **A. Consultas de solo lectura del catalogo de restaurantes**
  (`packages/domain-restaurantes/src/data-chat/sql.ts`). El texto SQL se copia identico en
  `assertions.sql` y `packages/domain-restaurantes/tests/data-chat/sql-drift.spec.ts` falla si divergen.
  Cubre cross-tenant (en ambos sentidos), cross-sucursal (gerente con membresia acotada, incluso
  si la aplicacion pasara `null` o un id ajeno), zona horaria `America/Merida` (pedido de las 20:30
  locales = 02:30 UTC del dia siguiente), cancelados fuera de ventas, items jsonb malformados,
  clientes recurrentes sin PII, promociones inactivas de otra organizacion y `anon`.
- **B. Bitacora** `core.data_chat_query_log` / `core.record_data_chat_query`
  (migracion `packages/db/migrations/0028_data_chat_query_log.sql`): actor = `auth.uid()`,
  cross-tenant y sesion de sistema rechazados, lectura solo owner/admin, INSERT directo
  rechazado, append-only, CHECKs de forma.
- **C. Base sin migrar**: con la funcion/tabla eliminada dentro de la transaccion, el SQL real falla
  con 42883/42P01 y `SAVEPOINT` + `ROLLBACK TO SAVEPOINT` deja la transaccion utilizable.

```
scripts/verify-data-chat/run.sh                        # Postgres efimero propio (initdb), a mano
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-data-chat   # como lo corre el CI
```

El workflow `postgres-real-gate.yml` lo descubre solo (tiene `bootstrap.sql`, `post-migrations.sql` y
`assertions.sql`). Convenciones del gate: alias `should_fail` = debe terminar en ERROR; alias
`..._deberia_ser_N` = esa consulta devuelve N; un bloque `DO` que lanza excepcion ante una
discrepancia = el escenario falla.
