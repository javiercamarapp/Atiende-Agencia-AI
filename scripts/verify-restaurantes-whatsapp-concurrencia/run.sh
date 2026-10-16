#!/usr/bin/env bash
# Verificacion de CONCURRENCIA REAL del WhatsApp y los pedidos de restaurantes (rescate del original
# atiende-restaurantes: `order_idempotency_concurrency.sh` y la prueba de mensajes simultaneos de 0a346be).
# Dos o mas conexiones psql SIMULTANEAS contra un Postgres real, con las migraciones reales de supabase/migrations/ y las RPC
# reales de restaurantes. El resto de scripts/verify-restaurantes-*/ corre cada escenario en UNA conexion (y
# `verify-restaurantes-sql` solo SIMULA la carrera con dos llamadas seguidas).
#
# Garantia de que la carrera es real (mismo patron que scripts/verify-citas-concurrencia): una "pistola de salida" (un
# controlador retiene un advisory lock exclusivo; los N trabajadores se bloquean en el y se comprueba en pg_locks que TODOS
# esperan) los libera juntos.
#
# Que prueba:
#   1. Misma llave de idempotencia, 2 y 8 conexiones: un solo pedido, todas reciben el mismo id y order_count sube UNA vez.
#   2. Misma llave con otro contenido: una crea, la otra PT409.
#   3. Sin llave, misma huella (doble envio): un solo pedido.
#   4. Llaves distintas del mismo cliente: 2 pedidos y order_count +2 (sin actualizacion perdida).
#   5. Reenvio del mismo message.id de Meta desde 3 conexiones: exactamente un claim (un turno, una respuesta).
#   6. Mensajes simultaneos del mismo cliente: exactamente un lease de conversacion; los demas son reintentables.
#   7. Tres mensajes del mismo cliente anexados en paralelo: el historial conserva los 3 (sin actualizacion perdida).
#   8. Control negativo de sobre-bloqueo: clientes y mensajes distintos NO se bloquean entre si.
#  10. Outbox de mensajeria (rescate de messaging_outbox_concurrency.sh): N conexiones reclaman a la vez (WhatsApp y correo); cada fila
#      se reclama UNA vez, ninguna se pierde y las huerfanas se reclaman al vencer el lease.
#
# Modos: local (por defecto) levanta un cluster efimero con initdb/pg_ctl; CI: VERIFY_USE_EXISTING_PG=1 usa el servidor ya corriendo
# de PGHOST/PGPORT/PGUSER/PGPASSWORD. Sin assertions.sql a proposito: run-gate.mjs no lo toma como un verify de una conexion;
# el workflow postgres-real-gate.yml lo invoca en su propio job.
set -eo pipefail

command -v psql >/dev/null 2>&1 || { echo "verify-restaurantes-whatsapp-concurrencia: falta 'psql' en PATH" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
DB="atiende_verify_rest_conc"
FAILS=0
CHECKS=0

if [ "${VERIFY_USE_EXISTING_PG:-0}" = "1" ]; then
  : "${PGHOST:=127.0.0.1}" "${PGPORT:=5432}" "${PGUSER:=postgres}"
  export PGHOST PGPORT PGUSER
  MODE="servidor existente ${PGHOST}:${PGPORT}"
else
  for bin in initdb pg_ctl; do
    command -v "$bin" >/dev/null 2>&1 || { echo "verify-restaurantes-whatsapp-concurrencia: falta '$bin' en PATH (instala Postgres localmente)" >&2; exit 1; }
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

ORG=00000000-0000-0000-0000-0000000c1801
CUST_1=00000000-0000-0000-0000-0000000c1821
CUST_2=00000000-0000-0000-0000-0000000c1822
GUN=7002

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

kind() { echo "$1" | cut -d: -f1; }
order_sql() { echo "select conc.try_order('$1', $2, '$3', $4);"; } # cliente total huella llave(literal SQL o null)
key_hash() { echo "md5('$1') || md5('$1' || 'x')"; }
count_key() { q "select count(*) from restaurantes.orders where organization_id='$ORG' and idempotency_key = $(key_hash "$1")"; }
order_count() { q "select order_count from restaurantes.customers where id='$1'"; }
phone_hash() { q "select md5('$1') || md5('$1' || 'x')"; }
claim_msg_sql() { echo "select restaurantes.claim_whatsapp_message('$ORG', '$1', '$2')::text;"; }
claim_conv_sql() { echo "select restaurantes.claim_whatsapp_conversation('$ORG', '$1', '$2', 120)::text;"; }
append_sql() { echo "select jsonb_array_length(restaurantes.whatsapp_append_turn('$ORG', '$1', jsonb_build_array(jsonb_build_object('role','user','text','$2'))))::text;"; }
count_of() { local c=0 x; for x in "${RES[@]}"; do [ "$x" = "$1" ] && c=$((c + 1)); done; echo "$c"; }

echo
echo "=== 1. Misma llave y misma huella, 2 conexiones simultaneas (6 rondas): un solo pedido, mismo id, order_count +1 ==="
for d in 1 2 3 4 5 6; do
  antes="$(order_count $CUST_1)"
  race "$(order_sql $CUST_1 250 "f1-$d" "'k1-$d'")" "$(order_sql $CUST_1 250 "f1-$d" "'k1-$d'")"
  expect "ronda $d: ambas ok y MISMO id (${RES[0]} | ${RES[1]})" "$(kind "${RES[0]}")/$(kind "${RES[1]}")/$([ "${RES[0]}" = "${RES[1]}" ] && echo igual || echo distinto)" "ok/ok/igual"
  expect "ronda $d: una sola fila con esa llave" "$(count_key "k1-$d")" "1"
  expect "ronda $d: order_count sube exactamente 1" "$(( $(order_count $CUST_1) - antes ))" "1"
done

echo
echo "=== 2. Ocho conexiones simultaneas con la misma llave: un solo pedido y todas reciben el mismo id ==="
antes="$(order_count $CUST_1)"
args=()
for k in 1 2 3 4 5 6 7 8; do args+=("$(order_sql $CUST_1 300 "f2" "'k2'")"); done
race "${args[@]}"
distintos="$(printf '%s\n' "${RES[@]}" | sort -u | wc -l | tr -d ' ')"
expect "las 8 devuelven el mismo resultado ok" "$(printf '%s\n' "${RES[@]}" | sort -u | head -1 | cut -d: -f1)/$distintos" "ok/1"
expect "una sola fila con esa llave" "$(count_key "k2")" "1"
expect "order_count sube exactamente 1" "$(( $(order_count $CUST_1) - antes ))" "1"

echo
echo "=== 3. Misma llave pero CONTENIDO distinto (otra huella) en carrera: una crea, la otra PT409 (6 rondas) ==="
for d in 1 2 3 4 5 6; do
  race "$(order_sql $CUST_1 100 "f3-$d-a" "'k3-$d'")" "$(order_sql $CUST_1 999 "f3-$d-b" "'k3-$d'")"
  oks=0; pt409=0
  for r in "${RES[@]}"; do
    [ "$(kind "$r")" = "ok" ] && oks=$((oks + 1))
    [ "$r" = "err:PT409" ] && pt409=$((pt409 + 1))
  done
  expect "ronda $d: 1 ok + 1 PT409 (${RES[0]} | ${RES[1]})" "$oks/$pt409" "1/1"
  expect "ronda $d: una sola fila con esa llave" "$(count_key "k3-$d")" "1"
done

echo
echo "=== 4. Sin llave, misma huella (doble envio del mismo pedido): un solo pedido pendiente (3 rondas) ==="
for d in 1 2 3; do
  antes="$(order_count $CUST_2)"
  race "$(order_sql $CUST_2 77 "f4-$d" null)" "$(order_sql $CUST_2 77 "f4-$d" null)"
  expect "ronda $d: ambas ok y MISMO id (${RES[0]} | ${RES[1]})" "$(kind "${RES[0]}")/$(kind "${RES[1]}")/$([ "${RES[0]}" = "${RES[1]}" ] && echo igual || echo distinto)" "ok/ok/igual"
  expect "ronda $d: order_count sube exactamente 1" "$(( $(order_count $CUST_2) - antes ))" "1"
done

echo
echo "=== 5. Llaves DISTINTAS del mismo cliente en carrera: 2 pedidos y order_count +2 (sin actualizacion perdida) (4 rondas) ==="
for d in 1 2 3 4; do
  antes="$(order_count $CUST_2)"
  race "$(order_sql $CUST_2 120 "f5-$d-a" "'k5-$d-a'")" "$(order_sql $CUST_2 130 "f5-$d-b" "'k5-$d-b'")"
  expect "ronda $d: ambas ok con ids distintos (${RES[0]} | ${RES[1]})" "$(kind "${RES[0]}")/$(kind "${RES[1]}")/$([ "${RES[0]}" = "${RES[1]}" ] && echo igual || echo distinto)" "ok/ok/distinto"
  expect "ronda $d: order_count sube exactamente 2" "$(( $(order_count $CUST_2) - antes ))" "2"
done

echo
echo "=== 6. Meta reenvia el MISMO message.id desde 3 conexiones: exactamente un claim (6 rondas) ==="
for d in 1 2 3 4 5 6; do
  PH="$(phone_hash "6-$d")"
  race "$(claim_msg_sql "wamid-6-$d" "$PH")" "$(claim_msg_sql "wamid-6-$d" "$PH")" "$(claim_msg_sql "wamid-6-$d" "$PH")"
  expect "ronda $d: 1 claim verdadero y 2 falsos (${RES[0]} ${RES[1]} ${RES[2]})" "$(count_of true)/$(count_of false)" "1/2"
  expect "ronda $d: una sola fila en el ledger" "$(q "select count(*) from restaurantes.whatsapp_inbound_events where message_id='wamid-6-$d'")" "1"
done

echo
echo "=== 7. Tres mensajes DISTINTOS del mismo cliente a la vez: un solo lease de conversacion, los otros son reintentables (6 rondas) ==="
for d in 1 2 3 4 5 6; do
  PH="$(phone_hash "7-$d")"
  race "$(claim_conv_sql "$PH" "wamid-7-$d-a")" "$(claim_conv_sql "$PH" "wamid-7-$d-b")" "$(claim_conv_sql "$PH" "wamid-7-$d-c")"
  expect "ronda $d: exactamente un lease concedido (${RES[0]} ${RES[1]} ${RES[2]})" "$(count_of true)/$(count_of false)" "1/2"
done

echo
echo "=== 8. Tres mensajes del mismo cliente anexados en paralelo: el historial conserva los 3 (6 rondas) ==="
for d in 1 2 3 4 5 6; do
  TEL="99900078$d"
  race "$(append_sql "$TEL" "uno-$d")" "$(append_sql "$TEL" "dos-$d")" "$(append_sql "$TEL" "tres-$d")"
  expect "ronda $d: el historial tiene exactamente 3 mensajes" "$(q "select jsonb_array_length(messages) from restaurantes.whatsapp_conversations where organization_id='$ORG' and phone='$TEL'")" "3"
  expect "ronda $d: estan los 3 textos (ninguno pisado)" "$(q "select count(*) from restaurantes.whatsapp_conversations c, jsonb_array_elements(c.messages) m where c.organization_id='$ORG' and c.phone='$TEL' and m->>'text' in ('uno-$d','dos-$d','tres-$d')")" "3"
done

echo
echo "=== 9. Control negativo de sobre-bloqueo: mensajes, clientes y pedidos DISTINTOS no se bloquean entre si ==="
race "$(claim_msg_sql "wamid-9-a" "$(phone_hash "9-a")")" "$(claim_msg_sql "wamid-9-b" "$(phone_hash "9-b")")" "$(claim_msg_sql "wamid-9-c" "$(phone_hash "9-c")")"
expect "3 claims de mensajes distintos: los 3 verdaderos" "$(count_of true)/$(count_of false)" "3/0"
race "$(claim_conv_sql "$(phone_hash "9-x")" "wamid-9-x")" "$(claim_conv_sql "$(phone_hash "9-y")" "wamid-9-y")"
expect "2 leases de clientes distintos: los 2 verdaderos" "$(count_of true)/$(count_of false)" "2/0"
race "$(order_sql $CUST_1 11 "f9-a" "'k9-a'")" "$(order_sql $CUST_2 22 "f9-b" "'k9-b'")"
expect "2 pedidos de clientes distintos: ambos ok con ids distintos" "$(kind "${RES[0]}")/$(kind "${RES[1]}")/$([ "${RES[0]}" = "${RES[1]}" ] && echo igual || echo distinto)" "ok/ok/distinto"

# --- helpers del outbox de mensajeria (escenario 10) ---
ORG_B=00000000-0000-0000-0000-0000000c1802
q "insert into core.organization (id, vertical, name, slug) values ('$ORG_B', 'restaurantes', 'Taqueria Concurrencia B', 'taqueria-concurrencia-b') on conflict do nothing"
# seed_outbox canal prefijo n_org_A n_org_B  -> siembra filas 'pending' (created_at distintos) en dos organizaciones
seed_outbox() {
  q "insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, created_at)
     select v.o, '$1', 'concurrencia', '$2-' || v.o::text || '-' || i, '{}'::jsonb, now() - interval '1 hour' + i * interval '1 second'
     from (values ('$ORG'::uuid, $3), ('$ORG_B'::uuid, $4)) v(o, n), generate_series(1, v.n) i"
}
# claim_hold_sql funcion argumentos -> reclama y MANTIENE la transaccion abierta 0.4 s (los bloqueos de fila siguen tomados mientras
# los demas reclaman: es ahi donde FOR UPDATE SKIP LOCKED debe repartir); devuelve los ids reclamados separados por coma
claim_hold_sql() {
  echo "create temp table t as select id from restaurantes.$1($2); select pg_sleep(0.4); select coalesce(string_agg(id::text, ',' order by id), '') from t;"
}
outbox_count() { q "select count(*) from restaurantes.messaging_outbox where channel='$1' and status='$2'"; } # canal estado
# drain funcion argumentos trabajadores rondas -> rondas de N conexiones simultaneas hasta que no quede nada reclamable;
# deja en ALL todos los ids reclamados (con repeticiones) y en FIRST los resultados de la primera carrera
drain() {
  local fn="$1" lim="$2" workers="$3" max="$4" r w args out x
  ALL=""; FIRST=()
  for ((r = 1; r <= max; r++)); do
    args=()
    for ((w = 0; w < workers; w++)); do args+=("$(claim_hold_sql "$fn" "$lim")"); done
    race "${args[@]}"
    [ "$r" -eq 1 ] && FIRST=("${RES[@]}")
    out=""
    for x in "${RES[@]}"; do [ -n "$x" ] && out="$out,$x"; done
    [ -z "$out" ] && break
    ALL="$ALL$out"
  done
}
total_ids() { echo "$ALL" | tr ',' '\n' | grep -c . || true; }
distinct_ids() { echo "$ALL" | tr ',' '\n' | grep . | sort -u | wc -l | tr -d ' '; }

echo
echo "=== 10. Outbox de mensajeria (WhatsApp y correo): N conexiones reclaman a la vez; cada fila se reclama UNA vez y ninguna se pierde ==="
# 10a. 60 mensajes de WhatsApp de dos organizaciones, 4 conexiones simultaneas con lotes de 10, transaccion abierta mientras reclaman.
seed_outbox whatsapp wa 30 30
expect "10a: sembrados 60 mensajes pendientes de WhatsApp" "$(outbox_count whatsapp pending)" "60"
drain claim_messaging_outbox_batch "10, 120" 4 12
primera="$(printf '%s\n' "${FIRST[@]}" | tr ',' '\n' | grep -c . || true)"
primera_u="$(printf '%s\n' "${FIRST[@]}" | tr ',' '\n' | grep . | sort -u | wc -l | tr -d ' ')"
expect "10a: en la primera carrera simultanea ninguna fila se entrega a dos conexiones ($primera filas, $primera_u distintas)" "$primera" "$primera_u"
con_filas=0; for x in "${FIRST[@]}"; do [ -n "$x" ] && con_filas=$((con_filas + 1)); done
expect "10a: la primera carrera reparte trabajo (al menos 2 conexiones obtuvieron filas)" "$([ "$con_filas" -ge 2 ] && echo si || echo no)" "si"
expect "10a: en total se reclamaron exactamente 60 filas, sin repeticiones ($(total_ids) reclamos, $(distinct_ids) distintas)" "$(total_ids)/$(distinct_ids)" "60/60"
expect "10a: ninguna fila de WhatsApp quedo pendiente (nada se perdio)" "$(outbox_count whatsapp pending)" "0"
expect "10a: las 60 estan en processing con claimed_at" "$(q "select count(*) from restaurantes.messaging_outbox where channel='whatsapp' and status='processing' and claimed_at is not null")" "60"

# 10b. Huerfanos: el trabajador muere sin completar; con el lease vigente nadie las reclama, con el lease vencido se reclaman UNA vez.
drain claim_messaging_outbox_batch "10, 120" 4 3
expect "10b: con el lease vigente nadie reclama las filas en processing" "$(total_ids)" "0"
q "update restaurantes.messaging_outbox set claimed_at = now() - interval '10 minutes' where channel='whatsapp' and status='processing'"
q "update restaurantes.messaging_outbox set claimed_at = now() where channel='whatsapp' and dedupe_key like '%-1' and status='processing'"
vivos="$(q "select count(*) from restaurantes.messaging_outbox where channel='whatsapp' and claimed_at > now() - interval '1 minute'")"
drain claim_messaging_outbox_batch "10, 120" 4 12
expect "10b: tras vencer el lease se reclaman solo las vencidas, exactamente una vez ($(total_ids) reclamos, $(distinct_ids) distintas, $vivos con lease vigente)" "$(total_ids)/$(distinct_ids)" "$((60 - vivos))/$((60 - vivos))"
expect "10b: ninguna fila quedo huerfana (todas con lease vigente de nuevo)" "$(q "select count(*) from restaurantes.messaging_outbox where channel='whatsapp' and status='processing' and claimed_at < now() - interval '1 minute'")" "0"

# 10c. Mismo reclamo concurrente en el canal de correo (claim_email_outbox_batch): 40 filas, 3 conexiones, lotes de 10.
q "update restaurantes.messaging_outbox set status='sent' where channel='whatsapp'"
seed_outbox email em 20 20
drain claim_email_outbox_batch "10" 3 12
expect "10c: correo, 40 filas reclamadas exactamente una vez ($(total_ids) reclamos, $(distinct_ids) distintas)" "$(total_ids)/$(distinct_ids)" "40/40"
expect "10c: correo, nada quedo pendiente" "$(outbox_count email pending)" "0"
expect "10c: cada fila de correo cuenta un solo intento (attempts = 1)" "$(q "select count(*) from restaurantes.messaging_outbox where channel='email' and attempts <> 1")" "0"

# 10d. Control de canal: el reclamo de WhatsApp no toca el correo pendiente.
q "update restaurantes.messaging_outbox set status='sent'"
seed_outbox whatsapp wb 5 5
seed_outbox email eb 5 5
drain claim_messaging_outbox_batch "10, 120" 3 6
expect "10d: WhatsApp reclama sus 10 filas y deja las 10 de correo pendientes" "$(total_ids)/$(outbox_count email pending)" "10/10"

echo
echo "=== resumen: $((CHECKS - FAILS))/$CHECKS comprobaciones OK ==="
if [ "$FAILS" -ne 0 ]; then
  echo "verify-restaurantes-whatsapp-concurrencia: FALLO ($FAILS comprobaciones)" >&2
  exit 1
fi
echo "verify-restaurantes-whatsapp-concurrencia: OK"
