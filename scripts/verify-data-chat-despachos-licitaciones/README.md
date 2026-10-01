# verify-data-chat-despachos-licitaciones

Verifica contra **Postgres real** (RLS + GRANT + `auth.uid()` reales) el SQL de solo lectura de los
catalogos de "Chatea con tus datos" de **despachos** y **licitaciones**:

- `packages/domain-despachos/src/data-chat/sql.ts` (10 consultas)
- `packages/domain-licitaciones/src/data-chat/sql.ts` (8 consultas)

El texto de cada consulta se copia identico en `assertions.sql`; los `sql-drift.spec.ts` de ambos paquetes
fallan si divergen. No agrega migraciones: la bitacora (`core.data_chat_query_log`, migracion 0029) ya acepta
las dos verticales.

## Que cubre (66 escenarios)

- **Despachos**: cifras exactas (cartera, antiguedad, CFDI, IVA acreditable, obligaciones, cierres, carga),
  cross-tenant en ambos sentidos, cross-cliente (contador con membership acotada a UN cliente: aunque la app
  pasara `null` o el id de otro cliente, RLS lo limita), pagados fuera de la cartera, lista 69-B solo por
  las funciones `security definer` (sin acceso a la property, otro despacho, staff de licitaciones y `anon`
  rechazados; las tablas `efos_*` no son legibles), `anon` sin acceso a las tablas.
- **Licitaciones**: cifras exactas, cross-tenant en ambos sentidos y cross-vertical, el rol `viewer` lee, preguntas de junta de aclaraciones sin cerrar (sin respuestas ni actas),
  dias restantes/semaforo en fecha **local** (una convocatoria que cierra a las 23:45 de Merida tiene 0 dias
  aunque en UTC ya sea otro dia), horizonte de renovaciones inclusivo, moneda distinta de MXN sin monto, zona
  horaria configurada, `anon` sin acceso.
- **Base sin migrar**: con la tabla/columna/funcion eliminada dentro de la transaccion, el SQL real falla
  con 42P01/42703/42883 y `SAVEPOINT` + `ROLLBACK TO SAVEPOINT` (el mecanismo de `runWithSavepointFallback`)
  deja la transaccion utilizable.

```
scripts/verify-data-chat-despachos-licitaciones/run.sh                                      # Postgres efimero propio (initdb), a mano
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-data-chat-despachos-licitaciones   # como lo corre el CI
```

El workflow `postgres-real-gate.yml` lo descubre solo (tiene `bootstrap.sql`, `post-migrations.sql` y
`assertions.sql`). Convenciones del gate: alias `should_fail` = debe terminar en ERROR; alias
`..._deberia_ser_N` = esa consulta devuelve N; un bloque `DO` que lanza excepcion ante una discrepancia = el
escenario falla.
