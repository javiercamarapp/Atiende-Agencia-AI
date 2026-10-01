# verify-data-chat-rentas

Verifica contra **Postgres real** (RLS + GRANT + `auth.uid()` reales) las consultas de solo lectura del
catalogo de **rentas vacacionales** de "Chatea con tus datos" (`packages/domain-rentas/src/data-chat/sql.ts`). El texto SQL
se copia identico en `assertions.sql` y `packages/domain-rentas/tests/data-chat/sql-drift.spec.ts` falla si divergen.

Cubre, por consulta (ocupacion y noches por unidad, ingresos por canal y por propietario, conflictos de calendario
abiertos, tareas pendientes, liquidaciones a propietarios, pagos de canal, propiedades visibles):

- **cross-tenant** en ambos sentidos;
- **cross-propiedad**: admin con membresia acotada a una propiedad, incluso si la aplicacion pasara `null` (todas) o el id de otra;
- **doble conteo**: reserva y bloqueo de propietario traslapados (la noche cuenta una vez), provisionales/canceladas/en conflicto
  fuera, liquidaciones re-emitidas (solo la ultima version), pagos con varias lineas (el monto no se repite);
- **moneda**: solo se suma MXN, lo demas se cuenta aparte;
- **rol sin finanzas** (operador): la RLS oculta lo financiero;
- **anon** rechazado;
- **base sin migrar**: tabla/columna eliminada dentro de la transaccion -> 42P01/42703 y `SAVEPOINT` + `ROLLBACK TO SAVEPOINT`
  deja la transaccion utilizable.

No hay migracion nueva: la bitacora (`core.record_data_chat_query`, 0029) es generica y se verifica en `scripts/verify-data-chat`.

```
scripts/verify-data-chat-rentas/run.sh                                           # Postgres efimero propio (initdb), a mano
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-data-chat-rentas  # como lo corre el CI
```

El workflow `postgres-real-gate.yml` lo descubre solo (tiene `bootstrap.sql`, `post-migrations.sql` y `assertions.sql`).
