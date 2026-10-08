#!/usr/bin/env bash
# Idempotencia CONCURRENTE de hoteles.sistema_emitir_mensaje_huesped (migración 046). Requiere que assertions.sql ya haya dejado sus fixtures
# (hoteles A/B, hold H1) en la base. Variables: HOST, PORT, DB.
#
#   1) Solape forzado: la sesión A emite y retiene su transacción 2 s; la sesión B intenta el MISMO (referencia, evento) a la vez y debe
#      ESPERAR al unique de la bitácora y recibir NULL cuando A confirma (nunca dos envíos).
#   2) Carrera de 8 conexiones sin pausa: exactamente UNA recibe un id; las otras 7, NULL.
#   3) Quedan 1 fila de bitácora y 1 mensaje en el outbox por cada prueba.
set -euo pipefail

HOST="${HOST:?}"; PORT="${PORT:?}"; DB="${DB:?}"
P=(psql -h "$HOST" -p "$PORT" -U postgres -d "$DB" -t -A -q -v ON_ERROR_STOP=1)
PROP='00000000-0000-0000-0000-0000000a1a01'
fallo() { echo "concurrencia: FALLO -- $1" >&2; exit 1; }

emitir_sql() { # $1 = id de referencia, $2 = clave
  cat <<SQL
select public.verify_as('');
select coalesce(hoteles.sistema_emitir_mensaje_huesped('$PROP', 'hold.aprobado', 'hold', '$1', 'whatsapp', null, 'mh.hold.aprobado', '$2',
  '{"to":"+5215511112222","phone_number_id":"10000000000001","body":"texto","transaccional":true}'::jsonb)::text, 'NULL');
SQL
}

R1='00000000-0000-0000-0000-0000000f9001'
R2='00000000-0000-0000-0000-0000000f9002'

echo "  - solape forzado (A retiene 2 s, B espera y recibe NULL)"
OUT_A="$(mktemp)"; OUT_B="$(mktemp)"
{ echo "begin;"; emitir_sql "$R1" "mh:conc:1"; echo "select pg_sleep(2);"; echo "commit;"; } | "${P[@]}" > "$OUT_A" &
PID_A=$!
sleep 0.7
{ echo "begin;"; emitir_sql "$R1" "mh:conc:1"; echo "commit;"; } | "${P[@]}" > "$OUT_B" &
PID_B=$!
wait "$PID_A" || fallo "la sesión A falló"
wait "$PID_B" || fallo "la sesión B falló"
RES_A="$(grep -E '^[0-9a-f-]{36}$|^NULL$' "$OUT_A" | tail -1)"
RES_B="$(grep -E '^[0-9a-f-]{36}$|^NULL$' "$OUT_B" | tail -1)"
[[ "$RES_A" != "NULL" && -n "$RES_A" ]] || fallo "A debía ganar y recibió '$RES_A'"
[[ "$RES_B" == "NULL" ]] || fallo "B debía recibir NULL y recibió '$RES_B'"
N_ENVIO="$("${P[@]}" -c "select count(*) from hoteles.mensaje_huesped_envio where ref_id = '$R1';")"
N_OUTBOX="$("${P[@]}" -c "select count(*) from hoteles.messaging_outbox where dedupe_key = 'mh:conc:1';")"
[[ "$N_ENVIO" == "1" ]] || fallo "se esperaba 1 fila de bitácora y hay $N_ENVIO"
[[ "$N_OUTBOX" == "1" ]] || fallo "se esperaba 1 mensaje en el outbox y hay $N_OUTBOX"

echo "  - carrera de 8 conexiones simultáneas"
OUTS=()
PIDS=()
for i in 1 2 3 4 5 6 7 8; do
  f="$(mktemp)"; OUTS+=("$f")
  { echo "begin;"; emitir_sql "$R2" "mh:conc:2"; echo "commit;"; } | "${P[@]}" > "$f" &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid" || fallo "una conexión de la carrera falló"; done
GANADORAS=0; NULAS=0
for f in "${OUTS[@]}"; do
  r="$(grep -E '^[0-9a-f-]{36}$|^NULL$' "$f" | tail -1)"
  if [[ "$r" == "NULL" ]]; then NULAS=$((NULAS + 1)); elif [[ -n "$r" ]]; then GANADORAS=$((GANADORAS + 1)); fi
done
[[ "$GANADORAS" == "1" && "$NULAS" == "7" ]] || fallo "se esperaba 1 ganadora y 7 NULL; hubo $GANADORAS ganadoras y $NULAS NULL"
N_ENVIO="$("${P[@]}" -c "select count(*) from hoteles.mensaje_huesped_envio where ref_id = '$R2';")"
N_OUTBOX="$("${P[@]}" -c "select count(*) from hoteles.messaging_outbox where dedupe_key = 'mh:conc:2';")"
[[ "$N_ENVIO" == "1" ]] || fallo "carrera: se esperaba 1 fila de bitácora y hay $N_ENVIO"
[[ "$N_OUTBOX" == "1" ]] || fallo "carrera: se esperaba 1 mensaje en el outbox y hay $N_OUTBOX"

echo "concurrencia: OK -- una sola marca y un solo mensaje por (referencia, evento), con solape forzado y con 8 conexiones."
