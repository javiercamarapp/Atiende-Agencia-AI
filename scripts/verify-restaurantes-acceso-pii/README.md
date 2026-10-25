# verify-restaurantes-acceso-pii

Verificacion manual, opt-in, contra un Postgres local real (initdb/pg_ctl/psql en PATH) de la migracion 097 (`restaurantes.registrar_acceso`). Mismo patron que `verify-restaurantes-audit-log`. Uso: `scripts/verify-restaurantes-acceso-pii/run.sh`. Los escenarios `should_fail` deben terminar en ERROR; los `deberia_ser_N` en N.
