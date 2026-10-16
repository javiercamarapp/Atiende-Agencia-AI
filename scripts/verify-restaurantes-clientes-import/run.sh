#!/usr/bin/env bash
# Verificacion manual, opt-in, contra un Postgres LOCAL real -- mismo patron que
# scripts/verify-restaurantes-audit-log/run.sh. Cubre
# packages/domain-restaurantes/migrations/054_clientes_cartera_import_y_alerta_comandas.sql
# (cartera de clientes, importacion y alerta de captura manual) contra RLS/GRANT/auth.uid()
# reales, que el repositorio en memoria nunca aplica. El gate de CI
# (scripts/verify-real-postgres-ci/run-gate.mjs) lo descubre solo.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH.
# Uso:  scripts/verify-restaurantes-clientes-import/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-clientes-import: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55801
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null

echo "==> arrancando Postgres efímero en el puerto $PGPORT"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden (incluye 054_clientes_cartera_import_y_alerta_comandas.sql)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios de autorización (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> concurrencia: dos importaciones simultaneas con los mismos telefonos y huellas distintas no duplican ni fallan"
CONC_ORG=00000000-0000-0000-0000-0000000f5a00
CONC_STAFF=00000000-0000-0000-0000-0000000f5e03
conc_import() {
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -q -t -A -c "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '$CONC_STAFF', true); select creados from restaurantes.importar_clientes('$CONC_ORG', '$1', (select jsonb_agg(jsonb_build_object('phone', lpad(g::text, 10, '0'), 'name', 'Concurrente ' || g)) from generate_series(1, 400) g)); commit;" >/dev/null
}
conc_import "$(printf '9%.0s' {1..64})" &
P1=$!
conc_import "$(printf '8%.0s' {1..64})" &
P2=$!
wait "$P1"; R1=$?
wait "$P2"; R2=$?
DUPS=$("${PSQL_DB[@]}" -t -A -c "select count(*) from (select phone from restaurantes.customers where organization_id = '$CONC_ORG' and name like 'Concurrente %' group by phone having count(*) > 1) d;")
TOTAL=$("${PSQL_DB[@]}" -t -A -c "select count(*) from restaurantes.customers where organization_id = '$CONC_ORG' and name like 'Concurrente %';")
echo "    codigos de salida: $R1 $R2 | telefonos duplicados: $DUPS | clientes concurrentes: $TOTAL (esperado 0 0 | 0 | 400)"
if [ "$R1" != "0" ] || [ "$R2" != "0" ] || [ "$DUPS" != "0" ] || [ "$TOTAL" != "400" ]; then
  echo "FALLO la verificacion de concurrencia" >&2
  exit 1
fi

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"should_fail\"/\"deberia_ser_0\" deben terminar en ERROR o 0 filas (correcto), el resto debe devolver filas/RETURNING reales."
