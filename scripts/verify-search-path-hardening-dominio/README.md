# verify-search-path-hardening-dominio

Prueba contra Postgres real de `packages/db/migrations/0027_search_path_hardening_funciones_dominio.sql`
(14 funciones con `search_path` fijado por `alter function`).

- `assertions.sql` (17 escenarios, juzgados por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI):
  `proconfig` exacto de las 14 funciones, ninguna sin `search_path`, funcionamiento con el `search_path`
  de sesion vaciado (`unaccent()` en `nearest_branch_by_colonia`, CAS de conversacion, reservar/liberar
  disponibilidad), bitacoras append-only que siguen bloqueando UPDATE/DELETE y un negativo `anon`.
- `run.sh`: lo mismo contra un Postgres efimero local (`initdb`/`pg_ctl`).
- Antes de la migracion: escenario 1 = 0 de 14, escenario 2 = 14 sin `search_path`, escenarios 3-6 fallan
  con el path vaciado (`function unaccent(text) does not exist`, `relation "conversations" does not exist`).
- `public.conversations` no existe en las migraciones del repo: el fixture la crea solo en la base efimera.
