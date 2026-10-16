#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón que scripts/verify-hoteles-grupos/run.sh.
# Ejercita la migración 045_hoteles_folio_cierre_carrera.sql (H-P3-01): (1) los escenarios de assertions.sql, y (2) la
# CONCURRENCIA REAL: dos sesiones psql distintas (equivalente a Promise.all de dos peticiones HTTP) disparan a la vez
# cargo + cierre, pago + cierre (ambos saldo_cero) y cierre + cierre sobre un folio nuevo, 20 repeticiones cada uno, con retardos aleatorios
# para barrer ambos órdenes de llegada. Invariantes exigidas en TODAS las repeticiones:
#   - nunca un folio 'cerrado' con close_reason 'saldo_cero' y saldo distinto de cero;
#   - en un doble cierre, exactamente un UPDATE gana.
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Uso:  scripts/verify-hoteles-folio-concurrencia/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-hoteles-folio-concurrencia: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55611
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
REPS="${REPS:-20}"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
echo "==> arrancando Postgres efímero en el puerto $PGPORT"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

"$(command -v psql)" -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> mock mínimo de plataforma + TODAS las migraciones reales de supabase/migrations/ + post-migrations"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null
# VERIFY_SIN_MIGRACION=1 omite la 045 para reproducir el defecto (el script debe FALLAR en rojo).
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  if [ "${VERIFY_SIN_MIGRACION:-0}" = "1" ] && [[ "$f" == *_045_hoteles_folio_cierre_carrera.sql ]]; then continue; fi
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> escenarios de una conexión (assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql" 2>&1 | tee "$WORKDIR/assertions.out"
if [ "${VERIFY_SIN_MIGRACION:-0}" != "1" ] && grep -E "asercion fallida|esperaba SQLSTATE|^psql:.*ERROR" "$WORKDIR/assertions.out" >/dev/null 2>&1; then
  echo "verify-hoteles-folio-concurrencia: FALLO un escenario de assertions.sql (ver arriba)" >&2
  exit 1
fi

echo ""
echo "==> concurrencia REAL: $REPS repeticiones por escenario (dos sesiones psql simultáneas)"
OWNER="00000000-0000-0000-0000-0000000a0a01"
ORG="00000000-0000-0000-0000-00000000a001"
PROP="00000000-0000-0000-0000-0000000a1a01"
RES="00000000-0000-0000-0000-0000000e0001"

new_folio() { # imprime el id de un folio abierto nuevo (secundario, de la reserva de pruebas)
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -At -q -c "insert into hoteles.folio (organization_id, property_id, reservation_id, is_primary, label) values ('$ORG', '$PROP', '$RES', false, 'Carrera $RANDOM') returning id;" | head -1
}
rnd() { awk -v s="$RANDOM" 'BEGIN{srand(s); printf "%.2f", rand()*0.30}'; }
as_owner="set local role authenticated; select set_config('request.jwt.claim.sub', '$OWNER', true);"

run_cargo() { # $1 folio, $2 retardo
  "${PSQL_DB[@]}" -At -q -c "begin; $as_owner select pg_sleep($2); insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept) values ('$ORG','$PROP','$1','Carrera',100,16,'extras'); commit;" >"$WORKDIR/c-$1.out" 2>&1 || true
}
run_pago() {
  "${PSQL_DB[@]}" -At -q -c "begin; $as_owner select pg_sleep($2); insert into hoteles.payment (organization_id, property_id, folio_id, amount, method, status) values ('$ORG','$PROP','$1',50,'efectivo','capturado'); commit;" >"$WORKDIR/p-$1.out" 2>&1 || true
}
run_cierre() { # $1 folio, $2 retardo, $3 motivo, $4 archivo de salida
  "${PSQL_DB[@]}" -At -q -c "begin; $as_owner select pg_sleep($2); update hoteles.folio set status='cerrado', closed_at=clock_timestamp(), close_reason='$3', updated_at=now() where id='$1' and status='abierto'; commit;" >"$WORKDIR/$4-$1.out" 2>&1 || true
}

fail=0
check() { # $1 etiqueta, $2 sql que cuenta violaciones
  local n
  n=$("${PSQL_DB[@]}" -At -q -c "$2")
  if [ "$n" != "0" ]; then echo "    VIOLACION en $1: $n folio(s)" >&2; fail=1; fi
}

for i in $(seq 1 "$REPS"); do
  f=$(new_folio); run_cargo "$f" "$(rnd)" & p1=$!; run_cierre "$f" "$(rnd)" saldo_cero cierre & p2=$!; wait "$p1" "$p2"
done
check "cargo + cierre saldo_cero" "select count(*) from hoteles.folio f where f.label like 'Carrera%' and f.status='cerrado' and f.close_reason='saldo_cero'
  and (select coalesce(sum(amount+tax_amount),0) from hoteles.charge where folio_id=f.id) <> (select coalesce(sum(amount),0) from hoteles.payment where folio_id=f.id and status='capturado');"
echo "    cargo + cierre: $REPS repeticiones"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -q -c "update hoteles.folio set label = 'Hecho1' where label like 'Carrera%';" >/dev/null

for i in $(seq 1 "$REPS"); do
  # Folio con saldo exactamente cero (cargo 116 + pago capturado 116): un pago extra y el cierre saldo_cero compiten.
  f=$(new_folio)
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -q -c "insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept) values ('$ORG','$PROP','$f','Base',100,16,'extras'); insert into hoteles.payment (organization_id, property_id, folio_id, amount, method, status) values ('$ORG','$PROP','$f',116,'efectivo','capturado');" >/dev/null
  run_pago "$f" "$(rnd)" & p1=$!; run_cierre "$f" "$(rnd)" saldo_cero cierre & p2=$!; wait "$p1" "$p2"
done
check "pago + cierre saldo_cero" "select count(*) from hoteles.folio f where f.label like 'Carrera%' and f.status='cerrado' and f.close_reason='saldo_cero'
  and (select coalesce(sum(amount+tax_amount),0) from hoteles.charge where folio_id=f.id) <> (select coalesce(sum(amount),0) from hoteles.payment where folio_id=f.id and status='capturado');"
echo "    pago + cierre: $REPS repeticiones"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -q -c "update hoteles.folio set label = 'Hecho2' where label like 'Carrera%';" >/dev/null

for i in $(seq 1 "$REPS"); do
  f=$(new_folio); run_cierre "$f" "$(rnd)" saldo_cero c1 & p1=$!; run_cierre "$f" "$(rnd)" cuenta_por_cobrar c2 & p2=$!; wait "$p1" "$p2"
done
# Todo folio termina cerrado (alguno de los dos UPDATE gana); el perdedor no toca ninguna fila (where status = abierto).
check "doble cierre sin ganador" "select count(*) from hoteles.folio f where f.label like 'Carrera%' and f.status <> 'cerrado';"
echo "    doble cierre: $REPS repeticiones"

if [ "$fail" != "0" ]; then
  echo "verify-hoteles-folio-concurrencia: FALLO la prueba de concurrencia" >&2
  exit 1
fi
echo ""
echo "==> listo — assertions.sql: cada escenario *_deberia_ser_N debe devolver N y ningún 'asercion fallida'; concurrencia: 0 violaciones en $((REPS * 3)) carreras."
