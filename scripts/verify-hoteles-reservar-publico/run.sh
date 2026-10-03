#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón que
# scripts/verify-hoteles-zona-horaria/run.sh. Ejercita la migración
# 044_hoteles_reservar_directo_publico.sql (H-42: motor de reservas directo
# publico: hold web con anticipo, pago, estado y cancelacion por token): RLS/GRANT/security definer reales, positivo,
# negativo, cross-tenant, anon y sesión de sistema. El mirror en memoria de
# domain-hoteles nunca aplica RLS/GRANT/triggers.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH; si faltan falla explícito.
# Uso:  scripts/verify-hoteles-reservar-publico/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-hoteles-reservar-publico: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
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
echo "==> concurrencia REAL: dos sesiones piden a la vez la ULTIMA habitacion Doble por la web (solo local: el gate de CI corre cada escenario en una sola conexion)"
OWNER="00000000-0000-0000-0000-0000000a0a01"
PROP="00000000-0000-0000-0000-0000000a1a01"
DBL="00000000-0000-0000-0000-0000000d0001"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -At -c "set role authenticated; select set_config('request.jwt.claim.sub', '$OWNER', false);
  insert into hoteles.booking_agent_policy (property_id, holds_enabled, web_enabled, web_deposit_pct) values ('$PROP', true, true, 0.3) on conflict (property_id) do update set holds_enabled = true, web_enabled = true, web_deposit_pct = 0.3;
  reset role; update hoteles.availability set total_rooms = 1, booked_rooms = 0 where room_type_id = '$DBL';" >/dev/null
web_hold_slow() { # $1 = llave, $2 = telefono, $3 = correo; retiene la transaccion 2 s tras crear para forzar el traslape
  "${PSQL_DB[@]}" -At -c "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '', true);
    select hoteles.web_booking_hold_create('$PROP', '$DBL', '2031-06-12', '2031-06-14', 2, 'Ana', '$2', '$3', '$1', 357000, 'v1', '2031-06-01T12:00:00Z'); select pg_sleep(2); commit;" >"$WORKDIR/hold-$1.out" 2>&1 || true
}
web_hold_slow "conc-web-0000001" "5215550000101" "a@example.com" & P1=$!
web_hold_slow "conc-web-0000002" "5215550000102" "b@example.com" & P2=$!
wait "$P1" "$P2"
OK=$( (grep -l -E '^\([0-9a-f-]{36},' "$WORKDIR"/hold-conc-web-*.out 2>/dev/null || true) | wc -l | tr -d ' ')
FAIL=$( (grep -l "sin_disponibilidad" "$WORKDIR"/hold-conc-web-*.out 2>/dev/null || true) | wc -l | tr -d ' ')
BOOKED=$("${PSQL_DB[@]}" -At -c "select max(booked_rooms) from hoteles.availability where room_type_id = '$DBL'")
HOLDS=$("${PSQL_DB[@]}" -At -c "select count(*) from hoteles.booking_hold where idempotency_key like 'conc-web-%'")
echo "    holds exitosos=$OK, rechazados por sin_disponibilidad=$FAIL, max(booked doble)=$BOOKED, filas de hold=$HOLDS"
if [ "$OK" != "1" ] || [ "$FAIL" != "1" ] || [ "$BOOKED" != "1" ] || [ "$HOLDS" != "1" ]; then
  echo "verify-hoteles-reservar-publico: FALLO la concurrencia (se esperaba 1 hold, 1 rechazo y 1 habitacion retenida)" >&2
  cat "$WORKDIR"/hold-conc-web-*.out >&2
  exit 1
fi

echo ""
echo "==> misma llave en paralelo: dos sesiones con la MISMA llave producen UNA sola retencion"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -At -c "update hoteles.availability set total_rooms = 5, booked_rooms = 0 where room_type_id = '$DBL';" >/dev/null
same_key() { # $1 = id de salida
  "${PSQL_DB[@]}" -At -c "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '', true);
    select hoteles.web_booking_hold_create('$PROP', '$DBL', '2031-06-12', '2031-06-14', 2, 'Ana', '5215550000201', 'c@example.com', 'conc-web-idem-01', 357000, 'v1', '2031-06-01T12:00:00Z'); select pg_sleep(2); commit;" >"$WORKDIR/idem-$1.out" 2>&1 || true
}
same_key a & P1=$!
same_key b & P2=$!
wait "$P1" "$P2"
HOLDS=$("${PSQL_DB[@]}" -At -c "select count(*) from hoteles.booking_hold where idempotency_key = 'conc-web-idem-01'")
BOOKED=$("${PSQL_DB[@]}" -At -c "select max(booked_rooms) from hoteles.availability where room_type_id = '$DBL'")
echo "    filas de hold con la misma llave=$HOLDS, max(booked doble)=$BOOKED"
if [ "$HOLDS" != "1" ] || [ "$BOOKED" != "1" ]; then
  echo "verify-hoteles-reservar-publico: FALLO la idempotencia concurrente (se esperaba 1 hold y 1 habitacion retenida)" >&2
  cat "$WORKDIR"/idem-*.out >&2
  exit 1
fi

echo ""
echo "==> listo -- revisa arriba: los escenarios con alias deberia_ser_N deben terminar en N filas; el resto debe terminar sin error."
