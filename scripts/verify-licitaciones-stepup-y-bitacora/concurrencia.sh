#!/usr/bin/env bash
# Verificacion de CONCURRENCIA REAL del consumo del step-up (038): DOS conexiones psql simultaneas contra un Postgres real, con las
# migraciones reales de supabase/migrations/ y la funcion real `core.consume_step_up`.
#
# Por que existe: assertions.sql corre cada escenario en UNA conexion; no puede probar que dos peticiones simultaneas con el MISMO token
# (mismo jti) dejan pasar exactamente una. Dos garantias de que la carrera es real:
#   * bloqueo determinista: la sesion A consume el jti SIN confirmar; se comprueba en pg_stat_activity que la sesion B esta ESPERANDO un
#     Lock (no serializada por azar); si A confirma, B recibe false (reuso); si A revierte (la accion fallo), B obtiene true: el token no
#     se gasta cuando la accion no se completa.
#   * "pistola de salida": un controlador retiene un advisory lock exclusivo; los trabajadores se bloquean en el y se liberan juntos.
#
# Modos: local (por defecto, cluster efimero con initdb/pg_ctl) o CI (VERIFY_USE_EXISTING_PG=1 con PGHOST/PGPORT/PGUSER/PGPASSWORD).
set -eo pipefail

command -v psql >/dev/null 2>&1 || { echo "verify-licitaciones-stepup-y-bitacora/concurrencia: falta 'psql' en PATH" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
DB="atiende_verify_stepup_conc"
FAILS=0
CHECKS=0

if [ "${VERIFY_USE_EXISTING_PG:-0}" = "1" ]; then
  : "${PGHOST:=127.0.0.1}" "${PGPORT:=5432}" "${PGUSER:=postgres}"
  export PGHOST PGPORT PGUSER
  MODE="servidor existente ${PGHOST}:${PGPORT}"
else
  for bin in initdb pg_ctl; do
    command -v "$bin" >/dev/null 2>&1 || { echo "falta '$bin' en PATH (instala Postgres localmente)" >&2; exit 1; }
  done
  PGDATA="$WORKDIR/pgdata"
  PORT=$(( (RANDOM % 20000) + 40000 ))
  initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
  pg_ctl -D "$PGDATA" -l "$WORKDIR/postgres.log" -o "-p $PORT -k $WORKDIR -c max_connections=60" start >/dev/null
  export PGHOST="$WORKDIR" PGPORT="$PORT" PGUSER=postgres
  MODE="cluster efimero initdb (puerto $PORT)"
fi

cleanup() {
  exec 3>&- 2>/dev/null || true
  exec 4>&- 2>/dev/null || true
  jobs -p | xargs kill 2>/dev/null || true
  psql -X -q -d postgres -c "drop database if exists $DB with (force);" >/dev/null 2>&1 || true
  if [ "${VERIFY_USE_EXISTING_PG:-0}" != "1" ]; then
    pg_ctl -D "$WORKDIR/pgdata" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

q() { psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -c "$1"; }

echo "==> modo: $MODE"
psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists $DB with (force);" -c "create database $DB;"
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null
echo "==> aplicando las migraciones reales de supabase/migrations/ en orden"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

ORG=38000000-0000-0000-0000-00000000c0d1
USR=38000000-0000-0000-0000-00000000c0a1
GUN=7038

q "insert into core.organization (id, vertical, name, slug) values ('$ORG', 'licitaciones', 'Org conc stepup', 'org-conc-stepup');
   insert into core.staff_user (id, email, full_name, created_via) values ('$USR', 'owner-conc-stepup@example.com', 'Owner', 'seed');
   insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values ('$USR', '$ORG', null, 'owner', 'owner');"

expect() { # etiqueta actual esperado
  CHECKS=$((CHECKS + 1))
  if [ "$2" = "$3" ]; then
    echo "   [PASS] $1"
  else
    FAILS=$((FAILS + 1))
    echo "   [FAIL] $1 -- esperado: '$3' obtenido: '$2'"
  fi
}

wait_for() { # descripcion, consulta que devuelve el valor esperado, valor esperado
  local i=0 got=""
  while [ $i -lt 300 ]; do
    got="$(q "$2")"
    [ "$got" = "$3" ] && return 0
    sleep 0.1; i=$((i + 1))
  done
  echo "   [FAIL] timeout esperando: $1 (ultimo valor: '$got', esperado '$3')"
  FAILS=$((FAILS + 1))
  return 1
}

consume_sql() { # jti
  echo "select core.consume_step_up('$1', '$USR', '$ORG', 'contract_sensitive', now() + interval '5 minutes');"
}

echo
echo "=== 1. Bloqueo determinista: B espera de verdad el consumo sin confirmar de A (commit -> B ve false; rollback -> B obtiene true) ==="
FIFO_A="$WORKDIR/a.fifo"
for variante in commit rollback; do
  JTI="jti-bloqueo-$variante"
  rm -f "$FIFO_A"; mkfifo "$FIFO_A"
  PGAPPNAME=conc_a psql -X -q -At -d "$DB" < "$FIFO_A" > "$WORKDIR/a.out" 2>&1 &
  A_PID=$!
  exec 4> "$FIFO_A"
  echo "set role authenticated; select set_config('request.jwt.claim.sub', '$USR', false); begin; $(consume_sql "$JTI")" >&4
  wait_for "A con la transaccion abierta" "select count(*) from pg_stat_activity where application_name='conc_a' and state='idle in transaction'" "1" || true
  PGAPPNAME=conc_b psql -X -q -At -d "$DB" -c "set role authenticated" -c "select set_config('request.jwt.claim.sub', '$USR', false)" \
    -c "$(consume_sql "$JTI")" > "$WORKDIR/b.out" 2>&1 &
  B_PID=$!
  wait_for "B bloqueada esperando el candado de la llave de A (wait_event_type=Lock)" "select count(*) from pg_stat_activity where application_name='conc_b' and wait_event_type='Lock'" "1" || true
  expect "variante $variante: B sigue ESPERANDO (no termino) mientras A no confirma ni revierte" "$(kill -0 "$B_PID" 2>/dev/null && echo bloqueada || echo termino)" "bloqueada"
  echo "$variante;" >&4
  wait "$B_PID" 2>/dev/null || true
  exec 4>&-
  wait "$A_PID" 2>/dev/null || true
  RB="$(tail -n 1 "$WORKDIR/b.out")"
  if [ "$variante" = "commit" ]; then
    expect "A confirmo el consumo: B recibe false (reuso)" "$RB" "f"
  else
    expect "A revirtio (la accion fallo): B obtiene el consumo (true), el token no se gasto" "$RB" "t"
  fi
  expect "una sola fila de consumo para el jti" "$(q "select count(*) from core.step_up_consumption where jti='$JTI'")" "1"
done

echo
echo "=== 2. Pistola de salida: dos peticiones con el MISMO token a la vez (10 rondas): exactamente una pasa ==="
FIFO_GUN="$WORKDIR/gun.fifo"
mkfifo "$FIFO_GUN"
psql -X -q -At -d "$DB" < "$FIFO_GUN" > /dev/null 2>&1 &
GUN_PID=$!
exec 3> "$FIFO_GUN"
for ronda in 1 2 3 4 5 6 7 8 9 10; do
  JTI="jti-carrera-$ronda"
  echo "select pg_advisory_lock($GUN);" >&3
  wait_for "controlador con el lock" "select count(*) from pg_locks where locktype='advisory' and objid=$GUN and granted" "1" || true
  i=0
  for _ in 1 2; do
    psql -X -q -At -d "$DB" -c "set role authenticated" -c "select set_config('request.jwt.claim.sub', '$USR', false)" \
      -c "select pg_advisory_lock_shared($GUN)" -c "$(consume_sql "$JTI")" > "$WORKDIR/res.$i" 2>&1 &
    i=$((i + 1))
  done
  wait_for "los 2 trabajadores esperando la pistola de salida" "select count(*) from pg_locks where locktype='advisory' and objid=$GUN and not granted" "2" || true
  echo "select pg_advisory_unlock($GUN);" >&3
  for pid in $(jobs -p); do
    [ "$pid" = "$GUN_PID" ] && continue
    wait "$pid" 2>/dev/null || true
  done
  R0="$(tail -n 1 "$WORKDIR/res.0")"; R1="$(tail -n 1 "$WORKDIR/res.1")"
  pasan=0; rechazadas=0
  for r in "$R0" "$R1"; do
    [ "$r" = "t" ] && pasan=$((pasan + 1))
    [ "$r" = "f" ] && rechazadas=$((rechazadas + 1))
  done
  expect "ronda $ronda: 1 pasa + 1 rechazada (resultados: $R0 | $R1)" "$pasan/$rechazadas" "1/1"
  expect "ronda $ronda: una sola fila de consumo" "$(q "select count(*) from core.step_up_consumption where jti='$JTI'")" "1"
done

echo
echo "=== resumen: $((CHECKS - FAILS))/$CHECKS comprobaciones OK ==="
if [ "$FAILS" -ne 0 ]; then
  echo "verify-licitaciones-stepup-y-bitacora/concurrencia: FALLO ($FAILS comprobaciones)" >&2
  exit 1
fi
echo "verify-licitaciones-stepup-y-bitacora/concurrencia: OK"
