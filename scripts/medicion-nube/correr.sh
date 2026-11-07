#!/usr/bin/env bash
# Una repeticion de la medicion del agente de WhatsApp de PM en un runner (GitHub Actions o cualquier Linux con Node 22,
# PostgreSQL y las dependencias del repo ya instaladas con `npm ci`). Reproduce correr-r21.sh / correr-sim.sh del arnes
# local, parametrizado por variables de entorno. NO imprime la llave. Se ejecuta DESDE la raiz del repo.
#
#   SUITE=r21|sim        suite (por omision r21)
#   ETQ=<texto>          etiqueta de la corrida (carpeta de salida)
#   REP=<n>              numero de repeticion (solo informativo, va a flag.txt)
#   MODELO=default|<id>  modelo del agente (QA_WA_MODEL); EFF=<esfuerzo> opcional
#   MODO=on|off|default  on = RESTAURANTES_CIERRE_MAQUINA_ESTADOS=1 ; off = WHATSAPP_CIERRE_UNA_VUELTA=0
#   CONC=<n>             conversaciones en paralelo dentro del job (por omision 2, como en la Mac)
#   NUCLEO=<regex>       ids de escenario (solo r21); por omision los 42 del NUCLEO de R21
#   EVIDENCIA_AGREGADOS=1  opt-in: medicion alineada (order_amendments) del juez
#   QA_SIM_FILTRO, QA_CORPUS_SIM   (solo sim) filtro y ruta del corpus PRIVADO (nunca vive en el repo)
#   TOPE_JOB_USD         corta el job si el uso de la llave sube mas que esto desde que arranco (r21: 2.0 ; sim: 5.0)
#   USO_BASE + TOPE_TOTAL_USD   corte global opcional: uso absoluto de la llave >= USO_BASE + TOPE_TOTAL_USD
#   OUT_DIR              salida (por omision $RUNNER_TEMP/medicion-<ETQ>)
#   OPENROUTER_API_KEY   obligatoria (en Actions viene del secreto, solo en el paso que corre esto)
# Salida en $OUT_DIR: log.txt, telemetria-turnos.jsonl, convos-*.json, flag.txt, uso-*.txt, uso-trace.txt, RESUMEN.txt,
#   y marcas CORTADA / INVALIDA / CORTE.txt. Codigo de salida: 0 corrio (revisar INVALIDA/CORTADA), 3 tope previo, 4 sin lectura
#   de uso, 5 fallo Postgres, 8 falta llave/corpus.
set -uo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(pwd)"
[ -f "$REPO/supabase/migrations/$(ls "$REPO/supabase/migrations" 2>/dev/null | head -1)" ] || { echo "correr.sh debe ejecutarse desde la raiz del repo (con supabase/migrations)"; exit 8; }
SUITE="${SUITE:-r21}"; ETQ="${ETQ:-local}"; REP="${REP:-1}"; MODELO="${MODELO:-default}"; MODO="${MODO:-on}"; EFF="${EFF:-}"; CONC="${CONC:-2}"
[[ "$SUITE" == r21 || "$SUITE" == sim ]] || { echo "SUITE invalida: $SUITE"; exit 8; }
[[ "$ETQ" =~ ^[A-Za-z0-9._-]{1,60}$ ]] || { echo "ETQ invalida"; exit 8; }
[[ "$CONC" =~ ^[0-9]+$ ]] || { echo "CONC invalido"; exit 8; }
[ -n "${OPENROUTER_API_KEY:-}" ] || { echo "falta OPENROUTER_API_KEY"; exit 8; }
KEY="$(printf '%s' "$OPENROUTER_API_KEY" | tr -d '[:space:]')"
if [ "$SUITE" = sim ]; then TOPE_JOB_USD="${TOPE_JOB_USD:-5.0}"; else TOPE_JOB_USD="${TOPE_JOB_USD:-2.0}"; fi
TOPE_TOTAL_USD="${TOPE_TOTAL_USD:-}"; USO_BASE="${USO_BASE:-}"
W="${RUNNER_TEMP:-/tmp}/ej-$ETQ-$REP"; OUT="${OUT_DIR:-${RUNNER_TEMP:-/tmp}/medicion-$ETQ}"
rm -rf "$W" "$OUT"; mkdir -p "$W/qa" "$OUT"
NUCLEO_DEF='^(G1|G2|G3|G4|G6|G7-8-10|S1|A05|A07|A09|A10|A12|A13|A14|A17|A19|A21|A22|A29|A32|A36|A37|A42|A48|T7-001|T7-008|T7-012|T7-017|T7-021|T7-026|T7-027|T7-031|T7-038|T7-043|T7-049|T7-061|T7-072|T7-073|T7-074|NU-1|NU-2|NU-3|NU-4)$'
NUCLEO="${NUCLEO:-$NUCLEO_DEF}"

# Lectura del uso de la llave (GET /api/v1/key; no gasta). Reintenta como el arnes local. Nunca imprime la llave.
uso(){ local i r; for i in 1 2 3 4 5; do r=$(curl -s -m 20 -H "Authorization: Bearer $KEY" https://openrouter.ai/api/v1/key | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["usage"])' 2>/dev/null); [ -n "$r" ] && { echo "$r"; return; }; sleep 5; done; }
U0=$(uso); [ -z "$U0" ] && { echo "no pude leer el uso de la llave"; exit 4; }
echo "[$SUITE $ETQ rep$REP] uso llave=$U0 ; tope job=$TOPE_JOB_USD ; tope total=${TOPE_TOTAL_USD:-<sin>} base=${USO_BASE:-<sin>}"
if [ -n "$USO_BASE" ] && [ -n "$TOPE_TOTAL_USD" ]; then
  python3 -c "import sys; sys.exit(0 if $U0-$USO_BASE < $TOPE_TOTAL_USD-0.6 else 1)" || { echo "TOPE TOTAL: no se corre (uso $U0, base $USO_BASE, tope $TOPE_TOTAL_USD)"; echo "TOPE-PREVIO" > "$OUT/NO-CORRIO"; exit 3; }
fi

# Corpus privado de la suite sim: llega por QA_CORPUS_SIM (el workflow lo decodifica desde un secreto); nunca esta en el repo.
if [ "$SUITE" = sim ]; then
  [ -n "${QA_CORPUS_SIM:-}" ] && [ -s "${QA_CORPUS_SIM}" ] || { echo "suite sim: falta QA_CORPUS_SIM (archivo del corpus privado)"; echo "SIN-CORPUS" > "$OUT/NO-CORRIO"; exit 8; }
fi

# Layout identico al local: <W>/qa (arnes) y <W>/repo (enlace al checkout), porque el arnes importa ../repo/...
for f in "$AQUI"/arnes/*.ts.txt; do cp "$f" "$W/qa/$(basename "${f%.txt}")"; done
cp "$AQUI"/arnes/*.sql "$AQUI"/arnes/cargar-config.py "$W/qa/"; cp -R "$AQUI/arnes/real-dump" "$W/qa/real-dump"
echo '{"type":"module","private":true}' > "$W/qa/package.json"
ln -s "$REPO" "$W/repo"

# Postgres fresco por corrida (cada job del workflow corre en su propio runner)
{ bash "$AQUI/pg-up.sh" "$W/qa" "$REPO" "$W/pgdata" && export PATH="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1):$PATH" \
  && python3 "$W/qa/cargar-config.py" && P(){ psql -h localhost -p 55491 -U postgres -d pmreal -v ON_ERROR_STOP=1 -q "$@"; } \
  && P -f "$W/qa/prep-canales.sql" >/dev/null && P -f "$W/qa/parche-grants-local.sql" >/dev/null 2>&1; } > "$OUT/pg.log" 2>&1 \
  || { echo "PG fresco fallo"; tail -5 "$OUT/pg.log"; exit 5; }

export QA_RES_DIR="$OUT" OPENROUTER_API_KEY="$KEY" QA_JUEZ="anthropic/claude-haiku-5.5" NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
unset QA_WA_MODEL QA_WA_EFFORT RESTAURANTES_CIERRE_MAQUINA_ESTADOS WHATSAPP_CIERRE_UNA_VUELTA
[ "$SUITE" = sim ] && export QA_SUITE=sim QA_SIM_FILTRO="${QA_SIM_FILTRO:-piloto}"
[ "$MODELO" != default ] && { export QA_WA_MODEL="$MODELO"; [ -n "$EFF" ] && export QA_WA_EFFORT="$EFF"; }
[ "$MODO" = on ] && export RESTAURANTES_CIERRE_MAQUINA_ESTADOS=1
[ "$MODO" = off ] && export WHATSAPP_CIERRE_UNA_VUELTA=0
[ "${EVIDENCIA_AGREGADOS:-}" = 1 ] && export EVIDENCIA_AGREGADOS=1
echo "suite=$SUITE rep=$REP etq=$ETQ modo=$MODO flag='${RESTAURANTES_CIERRE_MAQUINA_ESTADOS-<sin definir>}' una_vuelta='${WHATSAPP_CIERRE_UNA_VUELTA-<default ON>}' modelo='${QA_WA_MODEL-<default>}' esfuerzo='${QA_WA_EFFORT-}' evidencia_agregados='${EVIDENCIA_AGREGADOS-0}' conc=$CONC sha=$(git -C "$REPO" rev-parse HEAD)" > "$OUT/flag.txt"
TEL="$OUT/telemetria-turnos.jsonl"; : > "$TEL"; echo "$U0" > "$OUT/uso-inicial.txt"; date +%s > "$OUT/t0"

# Vigilante de gasto: corta el job al pasar el tope (el uso de la llave es GLOBAL: en matriz paralela el delta incluye a los hermanos;
# por eso el tope por job es holgado y existe ademas el tope total contra USO_BASE).
( while true; do sleep 15; U=$(uso); [ -z "$U" ] && continue; echo "$(date +%s) $U" >> "$OUT/uso-trace.txt"
  EXC=$(python3 -c "
u=float('$U'); u0=float('$U0'); tj=float('$TOPE_JOB_USD'); base='$USO_BASE'; tt='$TOPE_TOTAL_USD'
print(1 if (u-u0>=tj or (base and tt and u-float(base)>=float(tt))) else 0)")
  if [ "$EXC" = 1 ]; then echo "CORTE: uso=$U (job +$(python3 -c "print(round($U-$U0,3))"), tope job $TOPE_JOB_USD, base ${USO_BASE:-n/a}, tope total ${TOPE_TOTAL_USD:-n/a})" | tee -a "$OUT/CORTE.txt"; pkill -f "vite-node.*run.ts"; touch "$OUT/CORTADA"; break; fi; done ) &
WD=$!
( while true; do sleep 20; echo "$(date +%s) $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null) mem_libre_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo 2>/dev/null)" >> "$OUT/host-trace.txt"; done ) &
HT=$!

# vite-node: cwd = raiz del repo (como el local resuelve node_modules); config del arnes para que `pg` quede externo.
if [ "$SUITE" = sim ]; then ARGS=(sim "$CONC"); else ARGS=(guion,adv,pmc5,r11 "$CONC" "$NUCLEO"); fi
npx vite-node -c "$W/qa/vite-node.config.ts" "$W/qa/run.ts" "${ARGS[@]}" 2>&1 \
  | grep -v "^voz restaurantes" \
  | awk -v tel="$TEL" '/^\{"ts"/ { if (index($0, "\"evento\":\"whatsapp_turno\"")) { print >> tel; fflush(tel) } next } { print; fflush() }' > "$OUT/log.txt"
kill $WD $HT 2>/dev/null
U1=$(uso); [ -z "$U1" ] && { sleep 30; U1=$(uso); }; [ -z "$U1" ] && { echo "uso final no medido" > "$OUT/NOTA-USO.txt"; U1=$U0; }; echo "$U1" > "$OUT/uso-final.txt"; date +%s > "$OUT/t1"
pg_ctl -D "$W/pgdata" -m fast stop >/dev/null 2>&1 || true

NTURN=$(wc -l < "$TEL" | tr -d ' '); F1=$(grep -o "fetch failed" "$OUT/log.txt" 2>/dev/null | wc -l | tr -d ' '); F2=$(cat "$OUT"/convos*.json 2>/dev/null | grep -o "fetch failed" | wc -l | tr -d ' '); NFF=$(( F1 > F2 ? F1 : F2 ))
# Mismo criterio de invalidez que el arnes local (>8 "fetch failed" o <100 turnos). Con CORTADA la corrida queda incompleta aparte.
if [ "$NFF" -gt 8 ] || [ "$NTURN" -lt 100 ]; then echo "INVALIDA fetch_failed=$NFF turnos=$NTURN" > "$OUT/INVALIDA"; echo "INVALIDA fetch_failed=$NFF turnos=$NTURN"; fi
# Suite sim: el corpus es PRIVADO y los artefactos/logs de un repo publico son publicos. Se deja en OUT solo un resumen sin texto
# (ids, veredicto, latencias, marcas); log.txt, convos y transcripciones se mueven fuera de OUT y nunca se suben.
if [ "$SUITE" = sim ]; then
  mkdir -p "$W/privado"
  python3 - "$OUT" "$W/privado" <<'PY'
import glob, json, os, shutil, sys
out, priv = sys.argv[1], sys.argv[2]
for f in glob.glob(f"{out}/convos-*.json"):
    try: ev = json.load(open(f, encoding="utf-8"))
    except Exception: ev = []
    mini = []
    for e in ev:
        blob = json.dumps([e.get("hard"), e.get("transcript")], ensure_ascii=False)
        mini.append({"id": e.get("id"), "veredicto": e.get("veredicto"), "pendiente": e.get("pendiente"), "excluido": e.get("excluido"),
                     "ms": e.get("ms"), "hard": ["fetch failed"] if "fetch failed" in blob else [],
                     "transcript": [{"proveedor": 1}] if any(isinstance(t, dict) and t.get("proveedor") for t in (e.get("transcript") or [])) else []})
    json.dump(mini, open(f"{out}/convos-sim-min.json", "w"))
    shutil.move(f, f"{priv}/{os.path.basename(f)}")
if os.path.exists(f"{out}/log.txt"): shutil.move(f"{out}/log.txt", f"{priv}/log.txt")
PY
  grep -h "^RESUMEN\|^latencia turno" "$W/privado/log.txt" 2>/dev/null | sed 's/ | gasto:.*//' > "$OUT/.resumen-sim.tmp" || true
fi
LINE="=== FIN $ETQ rep=$REP delta_corrida=$(python3 -c "print(round($U1-$U0,4))") turnos_tel=$NTURN fetch_failed=$NFF"
echo "$LINE"; echo "$LINE" > "$OUT/RESUMEN.txt"
if [ "$SUITE" = sim ]; then cat "$OUT/.resumen-sim.tmp" >> "$OUT/RESUMEN.txt" 2>/dev/null; rm -f "$OUT/.resumen-sim.tmp"; else grep -h "^RESUMEN\|^latencia turno" "$OUT/log.txt" >> "$OUT/RESUMEN.txt" 2>/dev/null; fi
exit 0
