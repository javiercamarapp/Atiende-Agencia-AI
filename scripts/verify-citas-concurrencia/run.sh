#!/usr/bin/env bash
# Verificacion de CONCURRENCIA REAL contra la doble cita (C-17): dos o mas conexiones psql SIMULTANEAS contra un
# Postgres real, con las migraciones reales de supabase/migrations/ y las RPC reales de citas (migraciones 002/015).
#
# Por que existe: el resto de scripts/verify-citas-*/ corre sus escenarios en UNA conexion; ninguno puede probar que el
# EXCLUDE gist de citas.appointments (001) ni la idempotencia con pg_advisory_xact_lock (002/015) aguantan una carrera
# real. Esto lo prueba con dos garantias de que la carrera es real, no suerte de orden:
#   * "pistola de salida": un controlador retiene un advisory lock exclusivo; los N trabajadores se bloquean en el
#     (se comprueba en pg_locks que TODOS esperan) y se liberan juntos.
#   * bloqueo determinista: la sesion A retiene un INSERT sin confirmar; se comprueba en pg_stat_activity que la sesion B
#     esta esperando un Lock (no serializada por azar) y recien entonces A hace rollback/commit.
#
# Modos:
#   local (por defecto): levanta un cluster efimero con initdb/pg_ctl (requiere Postgres instalado, p. ej. brew).
#   CI:  VERIFY_USE_EXISTING_PG=1 usa el servidor ya corriendo de PGHOST/PGPORT/PGUSER/PGPASSWORD (servicio postgres:16).
#
# No esta pensado para el auto-descubrimiento de run-gate.mjs (no tiene assertions.sql): el workflow
# postgres-real-gate.yml lo invoca en su propio job.
set -eo pipefail

for bin in psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "verify-citas-concurrencia: falta '$bin' en PATH" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
DB="atiende_verify_concurrencia"
FAILS=0
CHECKS=0

if [ "${VERIFY_USE_EXISTING_PG:-0}" = "1" ]; then
  : "${PGHOST:=127.0.0.1}" "${PGPORT:=5432}" "${PGUSER:=postgres}"
  export PGHOST PGPORT PGUSER
  MODE="servidor existente ${PGHOST}:${PGPORT}"
else
  for bin in initdb pg_ctl; do
    command -v "$bin" >/dev/null 2>&1 || { echo "verify-citas-concurrencia: falta '$bin' en PATH (instala Postgres localmente)" >&2; exit 1; }
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
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/setup.sql" >/dev/null

ORG_A=00000000-0000-0000-0000-0000000c1701
ORG_B=00000000-0000-0000-0000-0000000c1702
PROV_A1=00000000-0000-0000-0000-0000000c1711
PROV_A2=00000000-0000-0000-0000-0000000c1712
PROV_B1=00000000-0000-0000-0000-0000000c1713
SVC_A=00000000-0000-0000-0000-0000000c1721
SVC_B=00000000-0000-0000-0000-0000000c1722
CUST_1=00000000-0000-0000-0000-0000000c1731
CUST_2=00000000-0000-0000-0000-0000000c1732
CUST_3=00000000-0000-0000-0000-0000000c1733
GUN=7001

# slot MES DIA -> literal de timestamptz (cada escenario usa su propio mes; cada ronda su propio dia)
slot() { printf '2031-%02d-%02d 10:00:00+00' "$1" "$2"; }

# SQL de cada trabajador (corre como sesion de sistema: rol authenticated con auth.uid() null)
sql_create() { # org prov svc cust slot key_seed fp_seed (las semillas ya vienen como literal SQL: 'x' o null)
  echo "select conc.try_create('$1','$2','$3','$4','$5'::timestamptz,30,$6,$7);"
}

expect() { # etiqueta actual esperado
  CHECKS=$((CHECKS + 1))
  if [ "$2" = "$3" ]; then
    echo "   [PASS] $1"
  else
    FAILS=$((FAILS + 1))
    echo "   [FAIL] $1 -- esperado: '$3' obtenido: '$2'"
  fi
}

# --- controlador de la pistola de salida (sesion que retiene el advisory lock exclusivo) ---
FIFO_GUN="$WORKDIR/gun.fifo"
mkfifo "$FIFO_GUN"
psql -X -q -At -d "$DB" < "$FIFO_GUN" > /dev/null 2>&1 &
GUN_PID=$!
exec 3> "$FIFO_GUN"

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

# race "sql1" "sql2" ... -> RES[0..n-1] con la ultima linea de cada trabajador, todos liberados a la vez
race() {
  local n=$# i=0 s
  echo "select pg_advisory_lock($GUN);" >&3
  wait_for "controlador con el lock" "select count(*) from pg_locks where locktype='advisory' and objid=$GUN and granted" "1" || true
  for s in "$@"; do
    psql -X -q -At -d "$DB" -c "set role authenticated" -c "select set_config('request.jwt.claim.sub','',false)" \
      -c "select pg_advisory_lock_shared($GUN)" -c "$s" > "$WORKDIR/res.$i" 2>&1 &
    i=$((i + 1))
  done
  wait_for "los $n trabajadores esperando la pistola de salida" "select count(*) from pg_locks where locktype='advisory' and objid=$GUN and not granted" "$n" || true
  echo "select pg_advisory_unlock($GUN);" >&3
  local pid
  for pid in $(jobs -p); do
    [ "$pid" = "$GUN_PID" ] && continue
    wait "$pid" 2>/dev/null || true
  done
  RES=()
  i=0
  while [ $i -lt $n ]; do
    RES[$i]="$(tail -n 1 "$WORKDIR/res.$i")"
    i=$((i + 1))
  done
}

# Perdedora de la carrera por un horario: AT423 (rechazo del EXCLUDE) o 40P01 (deadlock_detected: Postgres resuelve el ciclo "cada una espera la
# fila de la otra" abortando a UNA). Ambos son un rechazo seguro (la fila de la perdedora no se confirma); el TypeScript mapea las dos a
# `conflict_slot_taken` (packages/domain-citas: esConflictoDeHorario). Lo que NUNCA debe pasar: dos citas activas o dos ganadoras.
perdedora() { [ "$1" = "err:AT423" ] || [ "$1" = "err:40P01" ]; }
DEADLOCKS=0
kind() { echo "$1" | cut -d: -f1; }
code() { echo "$1" | cut -d: -f2; }
count_active() { q "select count(*) from citas.appointments where provider_id='$1' and starts_at='$2'::timestamptz and status in ('pending','confirmed','completed')"; }

echo
echo "=== 1. Mismo proveedor y horario, llaves DISTINTAS, 2 conexiones simultaneas (12 rondas): exactamente una gana, la otra pierde (AT423 o 40P01) ==="
for d in 1 2 3 4 5 6 7 8 9 10 11 12; do
  S="$(slot 1 $d)"
  race "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_1 "$S" "'k1-$d-a'" "'f1-$d-a'")" \
       "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_2 "$S" "'k1-$d-b'" "'f1-$d-b'")"
  oks=0; at423=0
  for r in "${RES[@]}"; do
    [ "$(kind "$r")" = "ok" ] && oks=$((oks + 1))
    if perdedora "$r"; then at423=$((at423 + 1)); [ "$r" = "err:40P01" ] && DEADLOCKS=$((DEADLOCKS + 1)); fi
  done
  expect "ronda $d: 1 ganadora + 1 perdedora (AT423/40P01) (resultados: ${RES[0]} | ${RES[1]})" "$oks/$at423" "1/1"
  expect "ronda $d: una sola cita activa en el horario" "$(count_active $PROV_A1 "$S")" "1"
done

echo
echo "=== 2. Ocho conexiones simultaneas por el mismo horario: exactamente una gana, siete pierden ==="
S="$(slot 2 1)"
args=()
for k in 1 2 3 4 5 6 7 8; do
  args+=("$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_1 "$S" "'k2-$k'" "'f2-$k'")")
done
race "${args[@]}"
oks=0; at423=0
for r in "${RES[@]}"; do
  [ "$(kind "$r")" = "ok" ] && oks=$((oks + 1))
  if perdedora "$r"; then at423=$((at423 + 1)); [ "$r" = "err:40P01" ] && DEADLOCKS=$((DEADLOCKS + 1)); fi
done
expect "8 conexiones: 1 ok / 7 perdedoras" "$oks/$at423" "1/7"
expect "8 conexiones: una sola cita activa" "$(count_active $PROV_A1 "$S")" "1"

echo
echo "=== 3. Idempotencia: MISMA llave y MISMA huella desde 2 conexiones: ambas reciben la misma cita, una sola fila (6 rondas) ==="
for d in 1 2 3 4 5 6; do
  S="$(slot 3 $d)"
  race "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_1 "$S" "'k3-$d'" "'f3-$d'")" \
       "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_1 "$S" "'k3-$d'" "'f3-$d'")"
  expect "ronda $d: ambas ok y con el MISMO id (${RES[0]} | ${RES[1]})" "$(kind "${RES[0]}")/$(kind "${RES[1]}")/$([ "${RES[0]}" = "${RES[1]}" ] && echo igual || echo distinto)" "ok/ok/igual"
  expect "ronda $d: una sola fila con esa llave" "$(q "select count(*) from citas.appointments where organization_id='$ORG_A' and idempotency_key=encode(sha256(convert_to('k3-$d','utf8')),'hex')")" "1"
done

echo
echo "=== 4. Misma llave pero DATOS distintos (otra huella) en carrera: una crea, la otra AT409 (6 rondas) ==="
for d in 1 2 3 4 5 6; do
  S="$(slot 4 $d)"
  race "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_1 "$S" "'k4-$d'" "'f4-$d-a'")" \
       "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_1 "$S" "'k4-$d'" "'f4-$d-b'")"
  oks=0; at409=0
  for r in "${RES[@]}"; do
    [ "$(kind "$r")" = "ok" ] && oks=$((oks + 1))
    [ "$r" = "err:AT409" ] && at409=$((at409 + 1))
  done
  expect "ronda $d: 1 ok + 1 AT409 (${RES[0]} | ${RES[1]})" "$oks/$at409" "1/1"
  expect "ronda $d: una sola fila con esa llave" "$(q "select count(*) from citas.appointments where organization_id='$ORG_A' and idempotency_key=encode(sha256(convert_to('k4-$d','utf8')),'hex')")" "1"
done

echo
echo "=== 5. Sin llave, MISMA huella (doble envio del mismo mensaje) en carrera: ambas ok con el mismo id, una sola fila ==="
for d in 1 2 3; do
  S="$(slot 5 $d)"
  race "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_1 "$S" null "'f5-$d'")" \
       "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_1 "$S" null "'f5-$d'")"
  expect "ronda $d: ambas ok y mismo id (${RES[0]} | ${RES[1]})" "$(kind "${RES[0]}")/$(kind "${RES[1]}")/$([ "${RES[0]}" = "${RES[1]}" ] && echo igual || echo distinto)" "ok/ok/igual"
  expect "ronda $d: una sola cita activa" "$(count_active $PROV_A1 "$S")" "1"
done

echo
echo "=== 6. Control negativo de sobre-bloqueo: otro proveedor y otra organizacion en el MISMO horario NO se bloquean ==="
S="$(slot 6 1)"
race "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_1 "$S" "'k6-a1'" "'f6-a1'")" \
     "$(sql_create $ORG_A $PROV_A2 $SVC_A $CUST_2 "$S" "'k6-a2'" "'f6-a2'")" \
     "$(sql_create $ORG_B $PROV_B1 $SVC_B $CUST_3 "$S" "'k6-b1'" "'f6-b1'")"
expect "las 3 reservas (2 proveedores de A + 1 de B) salen ok" "$(kind "${RES[0]}")/$(kind "${RES[1]}")/$(kind "${RES[2]}")" "ok/ok/ok"
expect "3 citas activas en ese horario (una por proveedor)" "$(q "select count(*) from citas.appointments where starts_at='$S'::timestamptz and status='pending'")" "3"

echo
echo "=== 7. Doble cancelacion simultanea: idempotente, ambas ok, la cita queda cancelada y libera el horario ==="
S="$(slot 7 1)"
ID7="$(q "select substr(conc.try_create('$ORG_A','$PROV_A1','$SVC_A','$CUST_1','$S'::timestamptz,30,'k7','f7'), 4)")"
race "select conc.try_cancel('$ORG_A','$ID7');" "select conc.try_cancel('$ORG_A','$ID7');"
expect "ambas cancelaciones ok:cancelled (${RES[0]} | ${RES[1]})" "${RES[0]}/${RES[1]}" "ok:cancelled/ok:cancelled"
expect "estado final cancelled" "$(q "select status from citas.appointments where id='$ID7'")" "cancelled"
expect "el horario quedo libre (0 citas activas)" "$(count_active $PROV_A1 "$S")" "0"

echo
echo "=== 8. Reagendar vs crear al MISMO horario destino, simultaneo: una gana, la otra pierde (6 rondas) ==="
for d in 1 2 3 4 5 6; do
  FROM="$(slot 8 $d)"
  TO="2031-09-$(printf '%02d' $d) 10:00:00+00"
  ID8="$(q "select substr(conc.try_create('$ORG_A','$PROV_A1','$SVC_A','$CUST_1','$FROM'::timestamptz,30,'k8-$d','f8-$d'), 4)")"
  race "select conc.try_reschedule('$ORG_A','$ID8','$TO'::timestamptz,30);" \
       "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_2 "$TO" "'k8-n-$d'" "'f8-n-$d'")"
  oks=0; at423=0
  for r in "${RES[@]}"; do
    [ "$(kind "$r")" = "ok" ] && oks=$((oks + 1))
    if perdedora "$r"; then at423=$((at423 + 1)); [ "$r" = "err:40P01" ] && DEADLOCKS=$((DEADLOCKS + 1)); fi
  done
  expect "ronda $d: 1 ganadora + 1 perdedora (${RES[0]} | ${RES[1]})" "$oks/$at423" "1/1"
  expect "ronda $d: una sola cita activa en el horario destino" "$(count_active $PROV_A1 "$TO")" "1"
done

echo
echo "=== 9. Bloqueo determinista del EXCLUDE: B espera de verdad el INSERT sin confirmar de A (rollback libera, commit rechaza) ==="
FIFO_A="$WORKDIR/a.fifo"
for variante in rollback commit; do
  rm -f "$FIFO_A"; mkfifo "$FIFO_A"
  S="$(slot 10 1)"; [ "$variante" = "commit" ] && S="$(slot 10 2)"
  PGAPPNAME=conc_a psql -X -q -At -d "$DB" < "$FIFO_A" > "$WORKDIR/a.out" 2>&1 &
  A_PID=$!
  exec 4> "$FIFO_A"
  echo "begin; insert into citas.appointments (organization_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values ('$ORG_A','$PROV_A1','$SVC_A','$CUST_1','$S'::timestamptz,'$S'::timestamptz + interval '30 minutes','pending');" >&4
  wait_for "A con la transaccion abierta" "select count(*) from pg_stat_activity where application_name='conc_a' and state='idle in transaction'" "1" || true
  PGAPPNAME=conc_b psql -X -q -At -d "$DB" -c "set role authenticated" -c "select set_config('request.jwt.claim.sub','',false)" \
    -c "$(sql_create $ORG_A $PROV_A1 $SVC_A $CUST_2 "$S" "'k9-$variante'" "'f9-$variante'")" > "$WORKDIR/b.out" 2>&1 &
  B_PID=$!
  wait_for "B bloqueada esperando el lock de A (wait_event_type=Lock)" "select count(*) from pg_stat_activity where application_name='conc_b' and wait_event_type='Lock'" "1" || true
  expect "variante $variante: el proceso de B sigue ESPERANDO (no termino) mientras A no confirma ni revierte" "$(kill -0 "$B_PID" 2>/dev/null && echo bloqueada || echo termino)" "bloqueada"
  echo "$variante;" >&4
  wait "$B_PID" 2>/dev/null || true
  exec 4>&-
  wait "$A_PID" 2>/dev/null || true
  RB="$(tail -n 1 "$WORKDIR/b.out")"
  if [ "$variante" = "rollback" ]; then
    expect "A hizo rollback: B obtiene el horario (ok)" "$(kind "$RB")" "ok"
  else
    expect "A hizo commit: B recibe AT423" "$RB" "err:AT423"
  fi
  expect "variante $variante: una sola cita activa en el horario" "$(count_active $PROV_A1 "$S")" "1"
done

echo
echo "=== resumen: $((CHECKS - FAILS))/$CHECKS comprobaciones OK (carreras resueltas por deadlock_detected 40P01: $DEADLOCKS) ==="
if [ "$FAILS" -ne 0 ]; then
  echo "verify-citas-concurrencia: FALLO ($FAILS comprobaciones)" >&2
  exit 1
fi
echo "verify-citas-concurrencia: OK"
