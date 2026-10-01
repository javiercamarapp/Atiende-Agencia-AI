# verify-despachos-efos-69b

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/014_despachos_efos_69b.sql`
(lista 69-B del SAT: tablas `efos_ingesta`/`efos_contribuyente` y 4 funciones).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI): ingesta
  de solo sistema (positivo, idempotente, reemplazo, negativos con sesión de staff y anon),
  acceso directo a tablas bloqueado, consulta solo para staff de despachos (negativos: staff de
  otra vertical, sin membresía, anon), y `efos_invoices_afectados` sin fuga cross-tenant.
- `run.sh`: lo mismo contra un Postgres efímero local (`initdb`/`pg_ctl`).
- No llama al SAT: los datos son filas ficticias insertadas por la propia verificación.
