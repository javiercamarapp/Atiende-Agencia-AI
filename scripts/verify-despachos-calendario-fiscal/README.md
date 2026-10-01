# verify-despachos-calendario-fiscal

D-26: verifica contra Postgres real la migracion `019_despachos_calendario_fiscal_tipos.sql`, que amplia el CHECK
de `despachos.fiscal_deadline.tipo` a `ISR, IVA, DIOT, Nómina, Balanza, Anual`.

Escenarios: (1) los 6 tipos se insertan con un staff real; (2) un tipo inventado sigue rechazado; (3) el periodo
exige `YYYY-MM`; (4) y (5) aislamiento entre despachos (RLS de property intacta); (6) y (7) `anon` sin acceso.

La migracion no agrega GRANT, policy ni funcion; este verify confirma que esa superficie no cambio.

Uso manual: `scripts/verify-despachos-calendario-fiscal/run.sh` (requiere `initdb`/`pg_ctl`/`psql`). En CI lo corre
`scripts/verify-real-postgres-ci/run-gate.mjs` por autodescubrimiento.
