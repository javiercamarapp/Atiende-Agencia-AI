# verify-data-chat-hoteles

Verifica contra **Postgres real** (RLS + GRANT + `auth.uid()` reales) las consultas de solo lectura del
catalogo de **hoteles** de "Chatea con tus datos" (`packages/domain-hoteles/src/data-chat/sql.ts`). El texto SQL se
copia identico en `assertions.sql` y `packages/domain-hoteles/tests/data-chat/sql-drift.spec.ts` falla si divergen.

Cubre, por consulta (ocupacion/ADR/RevPAR, ingresos por periodo, llegadas y salidas, cancelaciones, tickets
abiertos por SLA, housekeeping pendiente, hoteles visibles):

- **cross-tenant** en ambos sentidos;
- **cross-hotel**: gm con membresia acotada a un hotel, incluso si la aplicacion pasara `null` (todos) o el id de otro hotel;
- **doble conteo**: inventario con dos tipos de habitacion por dia vs. cargos; cargo reversado y propina fuera; llegadas/salidas disjuntas;
- **zona horaria** `America/Merida` (cancelacion de las 20:30 locales = 02:30 UTC del dia siguiente);
- **rol sin acceso a dinero/tickets de otros departamentos** (housekeeping): la RLS oculta cargos y tickets ajenos;
- **anon** rechazado;
- **base sin migrar**: tabla/columna eliminada dentro de la transaccion -> 42P01/42703 y `SAVEPOINT` + `ROLLBACK TO SAVEPOINT`
  deja la transaccion utilizable.

No hay migracion nueva: la bitacora (`core.record_data_chat_query`, 0029) es generica y se verifica en `scripts/verify-data-chat`.

```
scripts/verify-data-chat-hoteles/run.sh                                           # Postgres efimero propio (initdb), a mano
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-data-chat-hoteles  # como lo corre el CI
```

El workflow `postgres-real-gate.yml` lo descubre solo (tiene `bootstrap.sql`, `post-migrations.sql` y `assertions.sql`).
