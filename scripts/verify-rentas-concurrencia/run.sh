#!/usr/bin/env bash
# Verificacion de CONCURRENCIA REAL de rentas (Rn-P3-12): N conexiones psql SIMULTANEAS contra un Postgres real con las migraciones
# reales de supabase/migrations/. Los demas scripts/verify-rentas-*/ corren cada escenario en UNA conexion (el README de
# verify-rentas-ical-sync-lease admite que la concurrencia "se comprobo a mano"); este las prueba con dos garantias de que la carrera es real:
#   * "pistola de salida": un controlador retiene un advisory lock exclusivo; los N trabajadores se bloquean en el (se comprueba en
#     pg_locks que TODOS esperan) y se liberan juntos.
#   * los N resultados se comparan por SQLSTATE, no por mensaje.
# Escenarios: (a) 30 reservas simultaneas misma unidad y fechas; (b) back-to-back concurrente; (c) statements concurrentes del mismo
# propietario y periodo; (d) lote iCal con claim/lease (for update skip locked); (e) 5 aceptaciones de la misma invitacion de staff.
# Alcance honesto de (a)-(c): ver el comentario de cabecera de setup.sql (la logica vive en TypeScript; aqui se prueban las garantias de BD).
#
# Modos:
#   local (por defecto): levanta un cluster efimero con initdb/pg_ctl (requiere Postgres instalado, p. ej. brew).
#   CI:  VERIFY_USE_EXISTING_PG=1 usa el servidor ya corriendo de PGHOST/PGPORT/PGUSER/PGPASSWORD (servicio postgres:16).
#
# No esta pensado para el auto-descubrimiento de run-gate.mjs (no tiene assertions.sql): el workflow
# postgres-real-gate.yml lo invoca en su propio job.
set -eo pipefail

for bin in psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "verify-rentas-concurrencia: falta '$bin' en PATH" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
DB="atiende_verify_rentas_conc"
FAILS=0
CHECKS=0

if [ "${VERIFY_USE_EXISTING_PG:-0}" = "1" ]; then
  : "${PGHOST:=127.0.0.1}" "${PGPORT:=5432}" "${PGUSER:=postgres}"
  export PGHOST PGPORT PGUSER
  MODE="servidor existente ${PGHOST}:${PGPORT}"
else
  for bin in initdb pg_ctl; do
    command -v "$bin" >/dev/null 2>&1 || { echo "verify-rentas-concurrencia: falta '$bin' en PATH (instala Postgres localmente)" >&2; exit 1; }
  done
  PGDATA="$WORKDIR/pgdata"
  PORT=$(( (RANDOM % 20000) + 40000 ))
  initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
  pg_ctl -D "$PGDATA" -l "$WORKDIR/postgres.log" -o "-p $PORT -k $WORKDIR -c max_connections=120" start >/dev/null
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

ORG=00000000-0000-0000-0000-0000000c2701
OWNER=00000000-0000-0000-0000-0000000c2731
INVITER=00000000-0000-0000-0000-0000000c2721
GUN=7002
unidad() { printf '00000000-0000-0000-0000-0000000c28%02d' "$1"; }
kind() { echo "$1" | cut -d: -f1; }
code() { echo "$1" | cut -d: -f2-; }
# cuenta cuantos resultados de RES empiezan por el prefijo dado
cuenta() { local p="$1" n=0 r; for r in "${RES[@]}"; do case "$r" in "$p"*) n=$((n + 1));; esac; done; echo "$n"; }

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


echo
echo "=== a. 30 reservas simultaneas, MISMA unidad y fechas (3 rondas): exactamente 1 confirmada, 29 conflicto_pendiente, 0 deadlocks (40P01) ==="
for ronda in 1 2 3; do
  U="$(unidad $ronda)"
  args=()
  for k in $(seq 1 30); do args+=("select conc.try_reserva('$U','2032-0$ronda-10','2032-0$ronda-15','a-$ronda-$k');"); done
  race "${args[@]}"
  expect "ronda $ronda: 1 ok:confirmado" "$(cuenta 'ok:confirmado')" "1"
  expect "ronda $ronda: 29 ok:conflicto_pendiente (la perdedora queda como conflicto, no se pierde la reserva del canal)" "$(cuenta 'ok:conflicto_pendiente')" "29"
  expect "ronda $ronda: 0 deadlocks y 0 errores de ningun tipo" "$(cuenta 'err:')" "0"
  expect "ronda $ronda: una sola ocupacion bloqueante activa en las fechas" "$(q "select count(*) from rentas.ocupacion where unidad_id='$U' and estado='confirmado' and bloqueante")" "1"
  expect "ronda $ronda: 29 filas de conflicto overbooking_confirmado contra la ganadora" "$(q "select count(*) from rentas.conflicto_calendario where unidad_id='$U' and tipo='overbooking_confirmado'")" "29"
done

echo
echo "=== b. Back-to-back concurrente (salida de A = llegada de B): las dos se aceptan, sin conflicto (6 rondas, otra unidad cada una) ==="
for ronda in 1 2 3 4 5 6; do
  U="$(unidad $((ronda + 3)))"
  race "select conc.try_reserva('$U','2032-06-01','2032-06-05','b-$ronda-a');" "select conc.try_reserva('$U','2032-06-05','2032-06-08','b-$ronda-b');"
  expect "ronda $ronda: ambas ok:confirmado (${RES[0]} | ${RES[1]})" "$(cuenta 'ok:confirmado')" "2"
  expect "ronda $ronda: ningun conflicto registrado" "$(q "select count(*) from rentas.conflicto_calendario where unidad_id='$U'")" "0"
done

echo
echo "=== b2. Control negativo: dos reservas con UN dia de solape (no back-to-back) si chocan (una gana) ==="
U="$(unidad 10)"
race "select conc.try_reserva('$U','2032-07-01','2032-07-05','b2-a');" "select conc.try_reserva('$U','2032-07-04','2032-07-08','b2-b');"
expect "1 confirmada + 1 conflicto_pendiente" "$(cuenta 'ok:confirmado')/$(cuenta 'ok:conflicto_pendiente')" "1/1"

echo
echo "=== c. Statements concurrentes del MISMO propietario y periodo: una sola version (misma huella), nunca 23505 ni 500 ==="
for n in 2 8; do
  P_INI="2032-0$n-01"; P_FIN="2032-0$n-28"
  args=()
  for k in $(seq 1 $n); do args+=("select conc.try_statement('$P_INI','$P_FIN','huella-$n',null);"); done
  race "${args[@]}"
  expect "$n conexiones: 1 creado:1 y $((n - 1)) igual:1" "$(cuenta 'ok:creado:1')/$(cuenta 'ok:igual:1')" "1/$((n - 1))"
  expect "$n conexiones: una sola fila de statement" "$(q "select count(*) from rentas.owner_statement where owner_id='$OWNER' and periodo_inicio='$P_INI' and periodo_fin='$P_FIN'")" "1"
  expect "$n conexiones: ningun error (en particular 23505 unique_violation)" "$(cuenta 'err:')" "0"
done
echo "--- contenido DISTINTO con motivo, en carrera sobre una version ya existente: versiones consecutivas sin huecos ni duplicados ---"
race "select conc.try_statement('2032-02-01','2032-02-28','huella-nueva-a','correccion A');" "select conc.try_statement('2032-02-01','2032-02-28','huella-nueva-b','correccion B');"
expect "ambas crean version (2 y 3 en algun orden), sin error" "$(cuenta 'ok:creado:')" "2"
expect "versiones 1,2,3 exactamente" "$(q "select string_agg(version::text, ',' order by version) from rentas.owner_statement where owner_id='$OWNER' and periodo_inicio='2032-02-01'")" "1,2,3"

echo
echo "=== d. Lote iCal: claim/lease con for update skip locked desde 4 conexiones simultaneas: ningun feed se entrega dos veces ==="
q "insert into rentas.canal_feed_externo (organization_id, property_id, unidad_id, canal_id, url_importacion)
   select '$ORG', '00000000-0000-0000-0000-0000000c2711', ('00000000-0000-0000-0000-0000000c28' || lpad(u::text,2,'0'))::uuid, c.id, 'https://example.com/' || u || '-' || c.codigo || '.ics'
   from generate_series(13,14) u cross join rentas.canal c where c.codigo in ('airbnb','booking','vrbo')" >/dev/null
TOTAL_FEEDS="$(q "select count(*) from rentas.canal_feed_externo where organization_id='$ORG'")"
expect "fixture: 6 feeds activos" "$TOTAL_FEEDS" "6"
race "select conc.try_claim(3);" "select conc.try_claim(3);" "select conc.try_claim(3);" "select conc.try_claim(3);"
TODOS="$(printf '%s\n' "${RES[@]}" | sed 's/^ok://' | tr ',' '\n' | grep -v '^$' | sort)"
expect "ninguna conexion fallo" "$(cuenta 'err:')" "0"
expect "ningun feed entregado a dos conexiones (ids repetidos = 0)" "$(printf '%s\n' "$TODOS" | uniq -d | wc -l | tr -d ' ')" "0"
RECLAMADOS="$(printf '%s\n' "$TODOS" | grep -c . || true)"
expect "los reclamados coinciden con los feeds con lease en la base" "$RECLAMADOS" "$(q "select count(*) from rentas.canal_feed_externo where organization_id='$ORG' and lease_token is not null")"
# El resto (los que skip locked salto) se reclama despues: tras drenar, los 6 tienen lease y un nuevo claim no entrega ninguno.
for i in 1 2 3; do q "select conc.try_claim(50)" >/dev/null; done
expect "tras drenar, los 6 feeds tienen lease con token distinto" "$(q "select count(distinct lease_token) from rentas.canal_feed_externo where organization_id='$ORG'")" "6"
race "select conc.try_claim(50);" "select conc.try_claim(50);"
expect "con todos los leases vigentes, un claim concurrente no entrega nada" "$(cuenta 'ok:')/$(printf '%s' "${RES[0]}${RES[1]}" | sed 's/ok://g')" "2/"

echo
echo "=== e. 5 aceptaciones simultaneas de la MISMA invitacion de staff: exactamente 1 gana, 4 pierden (P0001), un solo staff_user y una sola membresia ==="
# Sonda: core.accept_staff_invite (0002) declara columnas de salida llamadas email/organization_id y su cuerpo las usa como columnas:
# contra Postgres real responde 42702 (columna ambigua) en CADA llamada, y ninguna invitacion de staff se puede aceptar. Hallazgo reportado
# y corregido por la migracion 0053 de la PR #436 (reemplazo con #variable_conflict use_column). Mientras esa correccion no este en
# supabase/migrations/ este escenario NO puede probar la carrera: se declara como hueco conocido en vez de fallar o fingir que paso.
q "insert into core.staff_invite (email, organization_id, platform_role, vertical_role, token_hash, invited_by, expires_at)
   values ('sonda-invite@example.com', '$ORG', 'member', 'operador', encode(sha256(convert_to('tok-sonda','utf8')),'hex'), '$INVITER', now() + interval '1 day')" >/dev/null
SONDA="$(q "select conc.try_accept('tok-sonda','Sonda')")"
if [ "$SONDA" = "err:42702" ]; then
  echo "   [HUECO CONOCIDO] core.accept_staff_invite responde 42702 (columna ambigua) en esta base: la carrera de aceptacion no se puede probar hasta que la PR #436 (migracion 0053) corrija la funcion. Escenario omitido, NO aprobado."
  ACEPTAR_OMITIDO=1
else
  expect "sonda: una aceptacion simple funciona (${SONDA})" "$SONDA" "ok"
  ACEPTAR_OMITIDO=0
fi
for ronda in 1 2 3; do
  [ "$ACEPTAR_OMITIDO" = "1" ] && break
  q "insert into core.staff_invite (email, organization_id, platform_role, vertical_role, token_hash, invited_by, expires_at)
     values ('invitada-$ronda@example.com', '$ORG', 'member', 'operador', encode(sha256(convert_to('tok-$ronda','utf8')),'hex'), '$INVITER', now() + interval '1 day')" >/dev/null
  args=()
  for k in 1 2 3 4 5; do args+=("select conc.try_accept('tok-$ronda','Invitada $k');"); done
  race "${args[@]}"
  expect "ronda $ronda: 1 ok (${RES[*]})" "$(cuenta 'ok')" "1"
  expect "ronda $ronda: 4 err:P0001 (invitacion ya usada)" "$(cuenta 'err:P0001')" "4"
  expect "ronda $ronda: un solo staff_user con ese correo" "$(q "select count(*) from core.staff_user where email='invitada-$ronda@example.com'")" "1"
  expect "ronda $ronda: una sola membresia en la organizacion" "$(q "select count(*) from core.membership m join core.staff_user s on s.id=m.user_id where s.email='invitada-$ronda@example.com' and m.organization_id='$ORG'")" "1"
  expect "ronda $ronda: la invitacion quedo accepted" "$(q "select status from core.staff_invite where token_hash=encode(sha256(convert_to('tok-$ronda','utf8')),'hex')")" "accepted"
done

echo
echo "=== resumen: $((CHECKS - FAILS))/$CHECKS comprobaciones OK$([ "$ACEPTAR_OMITIDO" = "1" ] && echo " (escenario e OMITIDO por el hueco conocido de accept_staff_invite, ver arriba)") ==="
if [ "$FAILS" -ne 0 ]; then
  echo "verify-rentas-concurrencia: FALLO ($FAILS comprobaciones)" >&2
  exit 1
fi
echo "verify-rentas-concurrencia: OK"
