#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón que
# scripts/verify-hoteles-zona-horaria/run.sh. Ejercita la migración
# 036_hoteles_grupos.sql (H-06: cotizacion de grupo, bloqueo de cuartos, pickup,
# rooming list y liberacion por cutoff): RLS/GRANT/security definer reales, positivo,
# negativo, cross-tenant, anon y sesión de sistema. El mirror en memoria de
# domain-hoteles nunca aplica RLS/GRANT/triggers.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH; si faltan falla explícito.
# Uso:  scripts/verify-hoteles-grupos/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-hoteles-grupos: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55599
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

echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios de hoteles (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> concurrencia REAL: dos sesiones aceptan a la vez bloqueos que compiten por los ultimos cuartos (solo local: el gate de CI corre cada escenario en una sola conexion)"
OWNER="00000000-0000-0000-0000-0000000a0a01"
PROP="00000000-0000-0000-0000-0000000a1a01"
DBL="00000000-0000-0000-0000-0000000d0001"
SUITE="00000000-0000-0000-0000-0000000d0002"
mkq() { # $1 = cuartos de doble, $2 = cuartos de suite -> imprime el id de una cotizacion ya enviada
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -At -c "set role authenticated; select set_config('request.jwt.claim.sub', '$OWNER', false);
    with q as (select id from hoteles.group_quote_create('$PROP', 'Concurrencia $RANDOM', null, null, '2031-06-12', '2031-06-15', '2031-06-05', now() + interval '1 day', 0, 0,
      jsonb_build_array(jsonb_build_object('room_type_id', '$DBL', 'rooms', $1, 'rate_cents', 100), jsonb_build_object('room_type_id', '$SUITE', 'rooms', $2, 'rate_cents', 100))))
    select hoteles.group_quote_send(id) from q;
    select id from hoteles.group_quote where status = 'enviada' order by created_at desc limit 1;" | tail -1
}
accept_slow() { # $1 = id de cotizacion; retiene la transaccion 2 s tras aceptar para forzar el traslape
  "${PSQL_DB[@]}" -At -c "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '$OWNER', true);
    select hoteles.group_quote_accept('$1'); select pg_sleep(2); commit;" >"$WORKDIR/acc-$1.out" 2>&1 || true
}
Q1=$(mkq 6 1); Q2=$(mkq 6 1)
accept_slow "$Q1" & P1=$!
accept_slow "$Q2" & P2=$!
wait "$P1" "$P2"
OK=$( (grep -l -E '^\([0-9a-f-]{36},' "$WORKDIR"/acc-*.out 2>/dev/null || true) | wc -l | tr -d ' ')
FAIL=$( (grep -l "sin_disponibilidad" "$WORKDIR"/acc-*.out 2>/dev/null || true) | wc -l | tr -d ' ')
BOOKED=$("${PSQL_DB[@]}" -At -c "select max(booked_rooms) from hoteles.availability where room_type_id = '$DBL'")
OVER=$("${PSQL_DB[@]}" -At -c "select count(*) from hoteles.availability where booked_rooms > total_rooms or booked_rooms < 0")
echo "    aceptaciones exitosas=$OK, rechazadas por sin_disponibilidad=$FAIL, max(booked doble)=$BOOKED, noches sobrevendidas/negativas=$OVER"
if [ "$OK" != "1" ] || [ "$FAIL" != "1" ] || [ "$BOOKED" != "6" ] || [ "$OVER" != "0" ]; then
  echo "verify-hoteles-grupos: FALLO la prueba de concurrencia (se esperaba 1 exito, 1 rechazo, 6 retenidos y 0 sobrevendidas)" >&2
  cat "$WORKDIR"/acc-*.out >&2
  exit 1
fi

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"deberia_ser_N\"/\"should_fail\" deben terminar en N filas o ERROR (correcto), el resto debe devolver filas/RETURNING reales."
