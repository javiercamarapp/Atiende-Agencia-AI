# verify-despachos-cron-sat-vencimientos

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/022_despachos_cron_sat_69b_vencimientos.sql`
(funciones de SOLO SISTEMA de los crons de estatus SAT de CFDI, alerta 69-B y vencimientos fiscales).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI, que descubre este directorio solo):
  positivo (barrido, registro, escalamiento idempotente), negativo (estado/nivel invalido, property sin ficha, staff
  autenticado y anon no pueden ejecutar ninguna funcion), terminalidad de `cancelado`, `pendiente` que no pisa un estado
  verificado, y aislamiento cross-tenant de la lectura de staff (RLS intacta).
- `run.sh`: lo mismo contra un Postgres efimero local (`initdb`/`pg_ctl`).
- No llama al SAT: los datos son filas ficticias insertadas por la propia verificacion.
