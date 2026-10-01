# verify-search-path-triggers-append-only

Prueba contra Postgres real de `packages/db/migrations/0035_search_path_triggers_append_only.sql`
(3 triggers append-only con `search_path = pg_catalog, pg_temp`).

- `assertions.sql` (10 escenarios, juzgados por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI):
  `proconfig` exacto de las 3 funciones; GUARD que falla si cualquier funcion (no de extension) de
  core/citas/hoteles/rentas/despachos/licitaciones/restaurantes/public queda sin `search_path`;
  UPDATE/DELETE siguen bloqueados con el `search_path` de sesion vaciado; INSERT sigue funcionando; negativo `anon`.
- `run.sh`: lo mismo contra un Postgres efimero local (`initdb`/`pg_ctl`).
- Antes de la migracion: escenario 1 = 0 de 3 y escenario 2 = 3 funciones sin `search_path`.
