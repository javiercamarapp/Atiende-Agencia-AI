# verify-data-chat-citas

Verifica contra **Postgres real** (RLS + GRANT + `auth.uid()` reales) el SQL de solo lectura del catalogo de "Chatea con
tus datos" de **citas** (`packages/domain-citas/src/data-chat/sql.ts`, 11 consultas) y la funcion
`citas.data_chat_reminder_delivery` de la migracion 027.

El texto de cada consulta se copia identico en `assertions.sql` (se genero desde el mismo modulo);
`packages/domain-citas/tests/data-chat/sql-drift.spec.ts` falla si divergen. La bitacora (`core.data_chat_query_log`, 0029)
ya acepta la vertical `citas`: no hace falta otra migracion para ella.

## Que cubre (47 escenarios)

- **Alcance**: sucursales visibles, cross-tenant en ambos sentidos, cross-sucursal (un admin con membership acotada a
  Centro: aunque la app pasara `null` o el id de otra sucursal, la RLS y la cobertura de la consulta lo limitan), `anon`
  sin acceso a citas ni ingresos.
- **Cifras exactas** con fixtures de dos clinicas: citas por dia en hora **local** (una cita a las 22:30 de Merida cuenta
  ese dia aunque en UTC sea el siguiente), ocupacion por profesional y por sucursal (horario semanal, excepciones del dia,
  dia cerrado, cita fuera de horario, profesional inactivo y profesional sin sucursal), cancelaciones y no-shows,
  ingresos por periodo y servicio (servicio sin precio, otra clinica con precio enorme), clientes nuevos vs recurrentes
  (una cita cancelada previa no vuelve recurrente), huecos libres con "ahora" fijo (se recorta el horario ya transcurrido
  y la cita en curso) y recordatorios pendientes.
- **Funcion de entrega de recordatorios**: owner/admin de la organizacion, admin acotado, rol `staff`, otra organizacion,
  `authenticated` sin sesion y `anon`; solo cuenta recordatorios (no otros eventos del outbox); `authenticated` no puede leer
  `citas.messaging_outbox`; catalogo (`security definer`, `search_path` fijo, sin EXECUTE para anon/public).
- **Base sin migrar**: con la funcion, la columna o la tabla eliminada, el SQL real falla con 42883 / 42703 / 42P01 y
  `SAVEPOINT` + `ROLLBACK TO SAVEPOINT` (el mecanismo de `runWithSavepointFallback`) deja la transaccion utilizable.

```
scripts/verify-data-chat-citas/run.sh                                       # Postgres efimero propio (initdb), a mano
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-data-chat-citas   # como lo corre el CI
```

El workflow `postgres-real-gate.yml` lo descubre solo (tiene `bootstrap.sql`, `post-migrations.sql` y `assertions.sql`).
Convenciones del gate: alias `should_fail` = debe terminar en ERROR; un bloque `DO` que lanza excepcion ante una
discrepancia = el escenario falla.
