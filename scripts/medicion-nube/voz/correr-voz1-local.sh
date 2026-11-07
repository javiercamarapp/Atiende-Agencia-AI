#!/usr/bin/env bash
# Banco «voz-1» (49 llamadas sinteticas del repo suelto, con ruido de ASR) contra POST /v1/restaurantes/voz/turno de ESTE checkout, en esta Mac:
# API real (buildProductionDeps) + Postgres efimero FRESCO con todas las migraciones + catalogo real de PM (arnes/real-dump) + cerebro v2 encendido.
# Reusa el arnes (arnes/*.ts.txt, pg-up.sh, cargar-config.py, prep-canales.sql) SIN modificarlo; lo propio vive en voz/. No imprime la llave.
#
#   FILTRO=<regex>   ids de escenario (ej. '^V-PED-01'); vacio = los 49
#   REPS=<n>         repeticiones (1)
#   RUIDO=ruido|limpio  nivel del dictado de ASR (ruido = «voz-1 con ruido»)
#   TOPE_USD=<x>     corte DURO: si el uso de la llave sube x USD desde el arranque, mata la corrida (0.20)
#   VOZ_TURNO_MODELO=preciso|rapido|respaldo   modelo del turno de voz (preciso = GPT-6 Luna, por omision)
#   VOZ1_BANCO_DIR   carpeta scripts/medicion del repo suelto (~/atiende-loop/work/wt-suelto-voz/scripts/medicion)
#   SECO=1           sin llave real ni gasto (llave falsa, sin vigilante): solo sirve para escenarios que no llaman al modelo (ej. FILTRO='^V-SIL-02'),
#                    prueba la ruta + migraciones + prep de punta a punta. No espera a otras mediciones de la llave (si al puerto 55491).
#   ETQ, OUT_BASE    etiqueta y carpeta de resultados (~/atiende-loop/work/pm-cuenta-real/medicion-voz1-ruta/<ETQ>)
# Una medicion a la vez: espera mientras corra otra (correr.mjs del suelto, otro vite-node del arnes o el puerto 55491 ocupado).
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; NUBE="$(cd "$AQUI/.." && pwd)"; REPO="$(cd "$NUBE/../.." && pwd)"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/.local/pg17/bin:$PATH" NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
FILTRO="${FILTRO:-}"; REPS="${REPS:-1}"; RUIDO="${RUIDO:-ruido}"; TOPE_USD="${TOPE_USD:-0.20}"
ETQ="${ETQ:-voz1-$(date +%m%d-%H%M)}"; OUT_BASE="${OUT_BASE:-$HOME/atiende-loop/work/pm-cuenta-real/medicion-voz1-ruta}"
VOZ1_BANCO_DIR="${VOZ1_BANCO_DIR:-$HOME/atiende-loop/work/wt-suelto-voz/scripts/medicion}"
[[ "$ETQ" =~ ^[A-Za-z0-9._-]{1,60}$ ]] || { echo "ETQ invalida"; exit 8; }
[ -f "$VOZ1_BANCO_DIR/escenarios/voz-1.mjs" ] || { echo "no encuentro el banco voz-1 en $VOZ1_BANCO_DIR"; exit 8; }
command -v initdb >/dev/null && command -v node >/dev/null || { echo "faltan initdb (~/.local/pg17/bin) o node"; exit 8; }
OUT="$OUT_BASE/$ETQ"; mkdir -p "$OUT"; W="${TMPDIR:-/tmp}/voz1-$ETQ"; rm -rf "$W"; mkdir -p "$W/qa"

# Solo procesos REALES de node (el ejecutable es node): un `while pgrep -f "...correr.mjs"` de otra shell tambien contiene el texto y no cuenta.
nodo(){ ps -axo comm=,args= | awk -v re="$1" '$1 ~ /(^|\/)node$/ && $0 ~ re { f=1 } END { exit !f }'; }
ocupado(){ nodo "scripts/medicion/correr[.]mjs" && { echo "correr.mjs"; return 0; }; nodo "vite-node" && { echo "otro vite-node"; return 0; }
  pg_isready -h localhost -p 55491 -q 2>/dev/null && { echo "puerto 55491 ocupado"; return 0; }; return 1; }
SECO="${SECO:-0}"
if [ "$SECO" = 1 ]; then ocupado(){ pg_isready -h localhost -p 55491 -q 2>/dev/null && { echo "puerto 55491 ocupado"; return 0; }; nodo "vite-node.*voz1[.]ts" && { echo "otro voz1"; return 0; }; return 1; }; fi
if q=$(ocupado); then [ "${ESPERAR:-1}" = 1 ] || { echo "ocupado: $q"; exit 9; }; n=0; while q=$(ocupado); do [ $((n % 10)) = 0 ] && echo "$(date +%H:%M:%S) espero: $q"; n=$((n+1)); sleep 30; done; fi

for f in "$NUBE"/arnes/*.ts.txt "$AQUI"/*.ts.txt; do cp "$f" "$W/qa/$(basename "${f%.txt}")"; done
cp "$NUBE"/arnes/*.sql "$NUBE"/arnes/cargar-config.py "$AQUI"/prep-voz1.sql "$W/qa/"; cp -R "$NUBE/arnes/real-dump" "$W/qa/real-dump"
echo '{"type":"module","private":true}' > "$W/qa/package.json"; ln -s "$REPO" "$W/repo"

if [ "$SECO" = 1 ]; then KEY="sk-seco-sin-llm"; else KEY="$(tr -d '[:space:]' < ~/.atiende-secrets/OPENROUTER_API_KEY.txt)"; fi; [ -n "$KEY" ] || { echo "falta la llave de OpenRouter"; exit 8; }
uso(){ local i r; for i in 1 2 3 4 5; do r=$(curl -s -m 20 -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["usage"])' 2>/dev/null); [ -n "$r" ] && { echo "$r"; return; }; sleep 5; done; }
if [ "$SECO" = 1 ]; then uso(){ echo 0; }; fi
U0=$(uso); [ -z "$U0" ] && { echo "no pude leer el uso de la llave"; exit 4; }; echo "$U0" > "$OUT/uso-inicial.txt"
echo "etq=$ETQ filtro='$FILTRO' reps=$REPS ruido=$RUIDO tope=$TOPE_USD modelo='${VOZ_TURNO_MODELO:-preciso}' sha=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" | tee "$OUT/flag.txt"

WD=""
if [ "$SECO" != 1 ]; then
( while true; do sleep 10; U=$(uso); [ -z "$U" ] && continue; echo "$(date +%s) $U" >> "$OUT/uso-trace.txt"
  if python3 -c "import sys; sys.exit(0 if $U-$U0 >= $TOPE_USD else 1)"; then echo "CORTE: uso=$U (tope $TOPE_USD)" | tee -a "$OUT/CORTE.txt"; touch "$OUT/CORTADA"; pkill -f "$W/qa/voz1.ts"; break; fi; done ) &
WD=$!
fi
trap '[ -n "$WD" ] && kill $WD 2>/dev/null; pg_ctl -D "$W/pgdata" -m fast stop >/dev/null 2>&1' EXIT

{ bash "$NUBE/pg-up.sh" "$W/qa" "$REPO" "$W/pgdata" && python3 "$W/qa/cargar-config.py" && P(){ psql -h localhost -p 55491 -U postgres -d pmreal -v ON_ERROR_STOP=1 -q "$@"; } \
  && P -f "$W/qa/prep-canales.sql" && P -f "$W/qa/prep-voz1.sql" && { P -f "$W/qa/parche-grants-local.sql" || true; }; } > "$OUT/pg.log" 2>&1 \
  || { echo "PG fresco fallo"; tail -5 "$OUT/pg.log"; exit 5; }

( export QA_RES_DIR="$OUT" OPENROUTER_API_KEY="$KEY" VOZ1_BANCO_DIR VOZ1_RUIDO="$RUIDO" VOZ1_REPS="$REPS"
  unset QA_WA_MODEL QA_WA_EFFORT QA_LLM_MODELS_JSON
  cd "$REPO" && npx vite-node -c "$W/qa/vite-node.config.ts" "$W/qa/voz1.ts" ${FILTRO:+"$FILTRO"} 2>&1 | grep -v '^{"ts"' > "$OUT/log.txt" )
[ -n "$WD" ] && kill $WD 2>/dev/null; U1=$(uso); echo "${U1:-$U0}" > "$OUT/uso-final.txt"
grep -h "^PASA\|^FALLA\|^RESUMEN" "$OUT/log.txt"; echo "gasto=$(python3 -c "print(round(${U1:-$U0}-$U0,4))") USD  salida=$OUT"
