#!/usr/bin/env bash
# QA adversarial R1 (lente automatizacion, restaurantes): escenarios contra un Postgres LOCAL EFIMERO real.
# Mismo patron que scripts/verify-restaurantes-pedidos-programados/run.sh. Nunca toca la base real.
# Imprime una columna `veredicto` por escenario: 'OK' o 'DEFECTO QA-restaurantes-R1-automatizacion-NN: ...'.
# S6 (solapamiento real de dos ejecuciones del cron de promocion) usa DOS sesiones psql concurrentes.
#
# Uso:  scripts/verify-qa-restaurantes-automatizacion/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-qa-restaurantes-automatizacion: falta '$bin' en PATH (instala Postgres local)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=$(( (RANDOM % 20000) + 40000 ))
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR -c listen_addresses=''" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> bootstrap de plataforma + TODAS las migraciones reales de supabase/migrations/"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null
done
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> escenarios S1..S5"
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "=== S6. (cobertura) dos ejecuciones SOLAPADAS del cron de promocion: cada pedido se promueve UNA vez ==="
"${PSQL_DB[@]}" -q -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, programado_para)
select ('00000000-0000-0000-0000-0000000f' || lpad(g::text, 4, '0'))::uuid, '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1',
       'Solape ' || g, '+52199900' || lpad(g::text, 5, '0'), 100, 'programado', '[]'::jsonb, 'web', now() + interval '10 minutes'
  from generate_series(1, 20) g;
SQL
# Sesion 1: promueve y SOSTIENE la transaccion 3 s (como un cron lento); sesion 2 corre a la mitad.
( "${PSQL_DB[@]}" -At -v ON_ERROR_STOP=1 -c "begin; set local role authenticated; select set_config('request.jwt.claim.sub','',true); select 'sesion1=' || jsonb_array_length(restaurantes.promover_pedidos_programados(null, now(), 30, null)); select pg_sleep(3); commit;" > "$WORKDIR/s1.out" ) &
BG=$!
sleep 1
"${PSQL_DB[@]}" -At -v ON_ERROR_STOP=1 -c "begin; set local role authenticated; select set_config('request.jwt.claim.sub','',true); select 'sesion2=' || jsonb_array_length(restaurantes.promover_pedidos_programados(null, now(), 30, null)); commit;" > "$WORKDIR/s2.out"
wait "$BG"
grep -h "sesion" "$WORKDIR/s1.out" "$WORKDIR/s2.out"
"${PSQL_DB[@]}" -At -c "select 'promovidos_total=' || count(*) || ' con_promovido_at=' || count(promovido_at) || ' veredicto=' || case when count(*) = 20 and count(distinct promovido_at) = 1 then 'OK' else 'FALLA cobertura S6' end from restaurantes.orders where customer_name like 'Solape %' and status = 'pending';"
# Tercera corrida tras el commit: idempotente.
"${PSQL_DB[@]}" -At -v ON_ERROR_STOP=1 -c "begin; set local role authenticated; select set_config('request.jwt.claim.sub','',true); select 'tercera_corrida=' || jsonb_array_length(restaurantes.promover_pedidos_programados(null, now(), 30, null)) || ' (deberia ser 0)'; commit;"

echo ""
echo "==> listo"
