#!/usr/bin/env bash
# Suite C3 (banco ciego 3, 80 escenarios) en ESTA Mac, contra la API real del checkout + Postgres efimero FRESCO por repeticion.
# Modelo de correr-r21.sh (qa local) + correr.sh (nube). No imprime la llave. Se puede llamar desde cualquier carpeta.
#
#   QA_WA_MODEL=<id>   modelo del agente (vacio = defaults de produccion). Ej.: openai/gpt-6-luna
#   QA_WA_EFFORT=<e>   esfuerzo opcional del agente
#   MODO=on|off|default  on (por omision, como correr.sh) = RESTAURANTES_CIERRE_MAQUINA_ESTADOS=1 ; off = WHATSAPP_CIERRE_UNA_VUELTA=0
#   REPS=<n>           repeticiones SECUENCIALES (1). Cada una con Postgres nuevo.
#   FILTRO=<regex>     ids de escenario (ej. '^C3-(PED-01|POL-03|ESC-01)')
#   CONC=<n>           conversaciones simultaneas (2)
#   TOPE_USD=<x>       corte DURO: si el uso de la llave sube x USD desde el arranque, mata la corrida (1.5)
#   ETQ=<texto>        etiqueta (c3-<fecha>)
#   SECO=1             corrida SECA sin LLM (sin cliente ni agente): buscar_sucursal_cercana y cotizar_pedido reales + siembra de previos.
#                      No lee la llave ni espera a otras mediciones (no gasta); escribe c3-seco.json para `c3-conciliar.py --seco`.
#   CEREBRO_V2=1|0     (1 por omision) bandera de la migracion 190 (restaurantes.agent_runtime_settings.cerebro_v2) para la organizacion de PM.
#                      Con 1 el turno usa las reglas portadas del suelto y el gateway con zdrEstricto: la escalera ZDR de produccion (Luna -> Haiku)
#                      manda y QA_WA_MODEL NO aplica (solo sobrescribe la escalera normal): con CEREBRO_V2=1 el agente es Luna por construccion.
#   QA_C3_CLIENTE=<id> modelo del cliente simulado (anthropic/claude-haiku-5.5, el del arnes de origen)
#   OUT_BASE=<dir>     carpeta de resultados (~/atiende-loop/work/pm-cuenta-real/medicion-c3)
# Salida: $OUT_BASE/<ETQ>/rep<n>/{log.txt,c3-resultados.json,telemetria-turnos.jsonl,pg.log} + uso-*.txt, CORTE.txt/CORTADA, AGREGADO.txt
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$AQUI/../.." && pwd)"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/.local/pg17/bin:$PATH" NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
REPS="${REPS:-1}"; CONC="${CONC:-2}"; TOPE_USD="${TOPE_USD:-1.5}"; MODO="${MODO:-on}"; FILTRO="${FILTRO:-}"; SECO="${SECO:-0}"; CEREBRO_V2="${CEREBRO_V2:-1}"
ETQ="${ETQ:-c3-$(date +%m%d-%H%M)}"; OUT_BASE="${OUT_BASE:-$HOME/atiende-loop/work/pm-cuenta-real/medicion-c3}"
[[ "$ETQ" =~ ^[A-Za-z0-9._-]{1,60}$ ]] || { echo "ETQ invalida"; exit 8; }
[[ "$CEREBRO_V2" == 0 || "$CEREBRO_V2" == 1 ]] || { echo "CEREBRO_V2 debe ser 0 o 1"; exit 8; }
[[ "$REPS" =~ ^[0-9]+$ && "$CONC" =~ ^[0-9]+$ ]] || { echo "REPS/CONC invalidos"; exit 8; }
command -v initdb >/dev/null && command -v node >/dev/null || { echo "faltan initdb (~/.local/pg17/bin) o node (~/.local/node/bin)"; exit 8; }
[ -x "$REPO/node_modules/.bin/vite-node" ] || { echo "falta node_modules en $REPO (npm ci)"; exit 8; }
OUT="$OUT_BASE/$ETQ"; mkdir -p "$OUT"
W="${TMPDIR:-/tmp}/c3-$ETQ"; rm -rf "$W"; mkdir -p "$W/qa"

# Una medicion a la vez (el uso de la llave es global: otra corrida contaminaria el tope y el gasto) y un solo dueno del puerto 55491.
# Solo procesos REALES de node (el ejecutable es node): un `while pgrep -f "...correr.mjs"` de otra shell tambien contiene el texto y no cuenta.
nodo(){ ps -axo comm=,args= | awk -v re="$1" '$1 ~ /(^|\/)node$/ && $0 ~ re { f=1 } END { exit !f }'; }
ocupado(){ nodo "scripts/medicion/correr[.]mjs" && { echo "correr.mjs"; return 0; }; nodo "vite-node.*run[.]ts" && { echo "otro vite-node run.ts"; return 0; }
  pg_isready -h localhost -p 55491 -q 2>/dev/null && { echo "puerto 55491 ocupado"; return 0; }; return 1; }
if [ "$SECO" != 1 ]; then
  n=0; while q=$(ocupado); do [ $((n % 10)) = 0 ] && echo "$(date +%H:%M:%S) espero: $q"; n=$((n+1)); sleep 5; done
else
  q=$(ocupado) && { case "$q" in correr.mjs) echo "(seco: corre aunque haya $q; no usa la llave)";; *) echo "ocupado: $q"; exit 9;; esac; }
fi

# Layout que espera el arnes: <W>/qa (copia de arnes/) y <W>/repo -> checkout (importa ../repo/...)
for f in "$AQUI"/arnes/*.ts.txt; do cp "$f" "$W/qa/$(basename "${f%.txt}")"; done
cp "$AQUI"/arnes/*.sql "$AQUI"/arnes/cargar-config.py "$AQUI"/arnes/ciego-3.json "$W/qa/"; cp -R "$AQUI/arnes/real-dump" "$W/qa/real-dump"
echo '{"type":"module","private":true}' > "$W/qa/package.json"; ln -s "$REPO" "$W/repo"

if [ "$SECO" = 1 ]; then KEY="sk-seco-sin-llm"; else
  KEY="$(tr -d '[:space:]' < ~/.atiende-secrets/OPENROUTER_API_KEY.txt)"; [ -n "$KEY" ] || { echo "falta ~/.atiende-secrets/OPENROUTER_API_KEY.txt"; exit 8; }
fi
uso(){ local i r; for i in 1 2 3 4 5; do r=$(curl -s -m 20 -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["usage"])' 2>/dev/null); [ -n "$r" ] && { echo "$r"; return; }; sleep 5; done; }
if [ "$SECO" != 1 ]; then U0=$(uso); [ -z "$U0" ] && { echo "no pude leer el uso de la llave"; exit 4; }; echo "$U0" > "$OUT/uso-inicial.txt"; echo "[c3 $ETQ] uso llave=$U0 ; tope corrida=$TOPE_USD USD"; fi
SHA=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
if [ "$CEREBRO_V2" = 1 ]; then NOTA_MODELO="cerebro_v2=1: escalera ZDR de produccion (Luna -> Haiku); QA_WA_MODEL='${QA_WA_MODEL:-}' NO aplica al agente"; else NOTA_MODELO="cerebro_v2=0"; fi
echo "[c3 $ETQ] $NOTA_MODELO"
echo "etq=$ETQ cerebro_v2=$CEREBRO_V2 ($NOTA_MODELO) modelo='${QA_WA_MODEL:-<default>}' esfuerzo='${QA_WA_EFFORT:-}' modo=$MODO reps=$REPS conc=$CONC filtro='${FILTRO}' tope=$TOPE_USD seco=$SECO cliente='${QA_C3_CLIENTE:-anthropic/claude-haiku-5.5}' sha=$SHA" > "$OUT/flag.txt"

# Vigilante de gasto (toda la corrida, todas las reps): corta al llegar al tope.
WD=""
if [ "$SECO" != 1 ]; then
  ( while true; do sleep 15; U=$(uso); [ -z "$U" ] && continue; echo "$(date +%s) $U" >> "$OUT/uso-trace.txt"
    if python3 -c "import sys; sys.exit(0 if $U-$U0 >= $TOPE_USD else 1)"; then echo "CORTE: uso=$U (+$(python3 -c "print(round($U-$U0,3))") >= tope $TOPE_USD)" | tee -a "$OUT/CORTE.txt"; touch "$OUT/CORTADA"; pkill -f "$W/qa/run.ts"; break; fi; done ) &
  WD=$!
fi
trap '[ -n "$WD" ] && kill $WD 2>/dev/null; pg_ctl -D "$W/pgdata" -m fast stop >/dev/null 2>&1' EXIT

for REP in $(seq 1 "$REPS"); do
  [ -f "$OUT/CORTADA" ] && { echo "corrida cortada por tope: no se corre rep$REP"; break; }
  R="$OUT/rep$REP"; rm -rf "$R"; mkdir -p "$R"
  { bash "$AQUI/pg-up.sh" "$W/qa" "$REPO" "$W/pgdata" && python3 "$W/qa/cargar-config.py" && P(){ psql -h localhost -p 55491 -U postgres -d pmreal -v ON_ERROR_STOP=1 -q "$@"; } \
    && P -f "$W/qa/prep-canales.sql" && P -f "$W/qa/prep-canales-c3.sql" \
    && P -c "insert into restaurantes.agent_runtime_settings (organization_id, cerebro_v2) values ('f838fd2c-967e-46fd-af8d-e0229b15748d', $([ "$CEREBRO_V2" = 1 ] && echo true || echo false)) on conflict (organization_id) do update set cerebro_v2 = excluded.cerebro_v2;" \
    && echo "cerebro_v2 en BD: $(P -tA -c "select cerebro_v2 from restaurantes.agent_runtime_settings where organization_id = 'f838fd2c-967e-46fd-af8d-e0229b15748d'")" && { P -f "$W/qa/parche-grants-local.sql" || true; }; } > "$R/pg.log" 2>&1 \
    || { echo "PG fresco fallo (rep$REP)"; tail -5 "$R/pg.log"; exit 5; }
  ( export QA_RES_DIR="$R" OPENROUTER_API_KEY="$KEY" QA_C3_REP="$REP"
    unset RESTAURANTES_CIERRE_MAQUINA_ESTADOS WHATSAPP_CIERRE_UNA_VUELTA QA_LLM_MODELS_JSON
    [ -z "${QA_WA_MODEL:-}" ] && unset QA_WA_MODEL QA_WA_EFFORT
    [ "$MODO" = on ] && export RESTAURANTES_CIERRE_MAQUINA_ESTADOS=1
    [ "$MODO" = off ] && export WHATSAPP_CIERRE_UNA_VUELTA=0
    [ "$SECO" = 1 ] && export QA_C3_SECO=1
    cd "$REPO" && npx vite-node -c "$W/qa/vite-node.config.ts" "$W/qa/run.ts" c3 "$CONC" ${FILTRO:+"$FILTRO"} 2>&1 \
      | grep -v "^voz restaurantes" \
      | awk -v tel="$R/telemetria-turnos.jsonl" '/^\{"ts"/ { if (index($0, "\"evento\":\"whatsapp_turno\"")) { print >> tel; fflush(tel) } next } { print; fflush() }' > "$R/log.txt" )
  pg_ctl -D "$W/pgdata" -m fast stop >/dev/null 2>&1
  grep -h "^RESUMEN\|^SECO listo" "$R/log.txt" | sed "s/^/[rep$REP] /"
  [ "$SECO" = 1 ] && [ -f "$R/c3-seco.json" ] && cp "$R/c3-seco.json" "$OUT/c3-seco.json"
done

if [ "$SECO" != 1 ]; then
  kill $WD 2>/dev/null; U1=$(uso); [ -z "$U1" ] && { sleep 20; U1=$(uso); }; echo "${U1:-$U0}" > "$OUT/uso-final.txt"
  python3 "$AQUI/agregar-c3.py" "$OUT" | tee "$OUT/AGREGADO.txt"
else
  echo "seco: $OUT/c3-seco.json  ->  python3 $AQUI/c3-conciliar.py --seco $OUT/c3-seco.json [--escribir]"
fi
