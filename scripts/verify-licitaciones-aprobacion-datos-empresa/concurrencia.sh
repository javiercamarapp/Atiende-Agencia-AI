#!/usr/bin/env bash
# Verificacion de CONCURRENCIA REAL de la decision sobre datos de empresa (036): DOS conexiones psql simultaneas contra un Postgres real,
# con las migraciones reales de supabase/migrations/ y la funcion real `licitaciones.decide_company_item`.
#
# Por que existe: assertions.sql corre cada escenario en UNA conexion; no puede probar que la transicion condicional
# (`where approval_status = 'pendiente_aprobacion'`) aguanta dos decisiones a la vez (WI-04). Dos garantias de que la carrera es real:
#   * bloqueo determinista: la sesion A retiene la decision SIN confirmar (candado de la fila); se comprueba en pg_stat_activity que la sesion B
#     esta ESPERANDO un Lock (no serializada por azar) y recien entonces A confirma (B ve 'conflict') o revierte (B gana).
#   * "pistola de salida": un controlador retiene un advisory lock exclusivo; los trabajadores se bloquean en el y se liberan juntos.
#
# Modos: local (por defecto, cluster efimero con initdb/pg_ctl) o CI (VERIFY_USE_EXISTING_PG=1 con PGHOST/PGPORT/PGUSER/PGPASSWORD).
# Sin assertions.sql en ESTE archivo a proposito: lo invoca el job `datos-empresa-concurrencia-gate` de postgres-real-gate.yml (assertions.sql
# del mismo directorio lo corre run-gate.mjs, una conexion por escenario).
set -eo pipefail

command -v psql >/dev/null 2>&1 || { echo "verify-licitaciones-aprobacion-datos-empresa/concurrencia: falta 'psql' en PATH" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
DB="atiende_verify_datos_empresa_conc"
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

ORG=36000000-0000-0000-0000-00000000c0d1
OWNER=36000000-0000-0000-0000-00000000c0a1
ADMIN=36000000-0000-0000-0000-00000000c0a4
WRITER=36000000-0000-0000-0000-00000000c0a3
GUN=7036

q "insert into core.organization (id, vertical, name, slug) values ('$ORG', 'licitaciones', 'Org conc', 'org-conc-datos');
   insert into core.staff_user (id, email, full_name, created_via) values
     ('$OWNER', 'owner-conc@example.com', 'Owner', 'seed'), ('$ADMIN', 'admin-conc@example.com', 'Admin', 'seed'), ('$WRITER', 'writer-conc@example.com', 'Writer', 'seed');
   insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
     ('$OWNER', '$ORG', null, 'owner', 'owner'), ('$ADMIN', '$ORG', null, 'admin', 'admin'), ('$WRITER', '$ORG', null, 'member', 'writer');"

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

# Crea una tarifa pendiente propuesta por el writer (el trigger fija proposed_by = auth.uid()).
nueva_tarifa() { # concepto -> id
  psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB" \
    -c "select set_config('request.jwt.claim.sub', '$WRITER', false)" \
    -c "insert into licitaciones.approved_rate (organization_id, concept, unit_price, valid_from) values ('$ORG', '$1', 10.00, '2026-01-01') returning id" | tail -n 1
}

decide_sql() { # actor kind id decision
  echo "select licitaciones.decide_company_item('$1', '$ORG', '$2', '$3', '$4');"
}

echo
echo "=== 1. Bloqueo determinista: B espera de verdad la decision sin confirmar de A (commit -> B ve conflict; rollback -> B gana) ==="
FIFO_A="$WORKDIR/a.fifo"
for variante in commit rollback; do
  RID="$(nueva_tarifa "tarifa-bloqueo-$variante")"
  rm -f "$FIFO_A"; mkfifo "$FIFO_A"
  PGAPPNAME=conc_a psql -X -q -At -d "$DB" < "$FIFO_A" > "$WORKDIR/a.out" 2>&1 &
  A_PID=$!
  exec 4> "$FIFO_A"
  echo "set role authenticated; select set_config('request.jwt.claim.sub', '$OWNER', false); begin; $(decide_sql $OWNER rate "$RID" aprobado)" >&4
  wait_for "A con la transaccion abierta" "select count(*) from pg_stat_activity where application_name='conc_a' and state='idle in transaction'" "1" || true
  PGAPPNAME=conc_b psql -X -q -At -d "$DB" -c "set role authenticated" -c "select set_config('request.jwt.claim.sub', '$ADMIN', false)" \
    -c "$(decide_sql $ADMIN rate "$RID" rechazado)" > "$WORKDIR/b.out" 2>&1 &
  B_PID=$!
  wait_for "B bloqueada esperando el candado de la fila de A (wait_event_type=Lock)" "select count(*) from pg_stat_activity where application_name='conc_b' and wait_event_type='Lock'" "1" || true
  expect "variante $variante: B sigue ESPERANDO (no termino) mientras A no confirma ni revierte" "$(kill -0 "$B_PID" 2>/dev/null && echo bloqueada || echo termino)" "bloqueada"
  echo "$variante;" >&4
  wait "$B_PID" 2>/dev/null || true
  exec 4>&-
  wait "$A_PID" 2>/dev/null || true
  RB="$(tail -n 1 "$WORKDIR/b.out")"
  if [ "$variante" = "commit" ]; then
    expect "A confirmo la aprobacion: B recibe conflict" "$RB" "conflict"
    expect "estado final aprobado por A (owner)" "$(q "select approval_status || ':' || approved_by from licitaciones.approved_rate where id='$RID'")" "aprobado:$OWNER"
    expect "una sola fila de bitacora" "$(q "select count(*) from licitaciones.company_data_audit where item_id='$RID'")" "1"
  else
    expect "A revirtio: B obtiene la decision (ok)" "$RB" "ok"
    expect "estado final rechazado por B (admin)" "$(q "select approval_status || ':' || approved_by from licitaciones.approved_rate where id='$RID'")" "rechazado:$ADMIN"
    expect "una sola fila de bitacora" "$(q "select count(*) from licitaciones.company_data_audit where item_id='$RID'")" "1"
  fi
done

echo
echo "=== 2. Pistola de salida: owner y admin deciden la MISMA tarifa a la vez (10 rondas): exactamente un ok y un conflict ==="
FIFO_GUN="$WORKDIR/gun.fifo"
mkfifo "$FIFO_GUN"
psql -X -q -At -d "$DB" < "$FIFO_GUN" > /dev/null 2>&1 &
GUN_PID=$!
exec 3> "$FIFO_GUN"
for ronda in 1 2 3 4 5 6 7 8 9 10; do
  RID="$(nueva_tarifa "tarifa-carrera-$ronda")"
  echo "select pg_advisory_lock($GUN);" >&3
  wait_for "controlador con el lock" "select count(*) from pg_locks where locktype='advisory' and objid=$GUN and granted" "1" || true
  i=0
  for actor in "$OWNER:aprobado" "$ADMIN:rechazado"; do
    who="${actor%%:*}"; dec="${actor##*:}"
    psql -X -q -At -d "$DB" -c "set role authenticated" -c "select set_config('request.jwt.claim.sub', '$who', false)" \
      -c "select pg_advisory_lock_shared($GUN)" -c "$(decide_sql "$who" rate "$RID" "$dec")" > "$WORKDIR/res.$i" 2>&1 &
    i=$((i + 1))
  done
  wait_for "los 2 trabajadores esperando la pistola de salida" "select count(*) from pg_locks where locktype='advisory' and objid=$GUN and not granted" "2" || true
  echo "select pg_advisory_unlock($GUN);" >&3
  for pid in $(jobs -p); do
    [ "$pid" = "$GUN_PID" ] && continue
    wait "$pid" 2>/dev/null || true
  done
  R0="$(tail -n 1 "$WORKDIR/res.0")"; R1="$(tail -n 1 "$WORKDIR/res.1")"
  oks=0; conflicts=0
  for r in "$R0" "$R1"; do
    [ "$r" = "ok" ] && oks=$((oks + 1))
    [ "$r" = "conflict" ] && conflicts=$((conflicts + 1))
  done
  expect "ronda $ronda: 1 ok + 1 conflict (resultados: $R0 | $R1)" "$oks/$conflicts" "1/1"
  expect "ronda $ronda: una sola fila de bitacora" "$(q "select count(*) from licitaciones.company_data_audit where item_id='$RID'")" "1"
done

echo
echo "=== resumen: $((CHECKS - FAILS))/$CHECKS comprobaciones OK ==="
if [ "$FAILS" -ne 0 ]; then
  echo "verify-licitaciones-aprobacion-datos-empresa/concurrencia: FALLO ($FAILS comprobaciones)" >&2
  exit 1
fi
echo "verify-licitaciones-aprobacion-datos-empresa/concurrencia: OK"
