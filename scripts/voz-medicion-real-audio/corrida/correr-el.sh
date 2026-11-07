#!/usr/bin/env bash
# uso: correr-el.sh <rep> <filtro> <etiqueta>
# Espera carga (1 min) <= CARGA_MAX (10 por omision) sostenida 1 min y que no haya otra medicion; revisa presupuesto; BD fresca desde pmreal_base (Postgres local 55497).
# Resultados y grabaciones en <repo>/.voz-qa/ (fuera de git).
set -u
D=$(cd "$(dirname "$0")" && pwd); M=$(cd "$D/../../.." && pwd); Q=$D/qa
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/.local/pg17/bin:$PATH" NODE_OPTIONS=--max-old-space-size=3072
ok=0
while [ $ok -lt 6 ]; do
  l=$(sysctl -n vm.loadavg | awk '{print $2}')
  if pgrep -f "node.*scripts/medicion/correr.mjs" >/dev/null || pgrep -f "voz-medicion-real-audio/(ejecutar-audio|e2e-livekit)" >/dev/null || awk "BEGIN{exit !($l > ${CARGA_MAX:-10})}"; then ok=0; else ok=$((ok+1)); fi
  sleep 10
done
echo "$(date '+%T') arranca load=$(sysctl -n vm.loadavg)"
bash "$D/con-presupuesto.sh" --solo-revisar || exit 4
P=(psql -h localhost -p 55497 -U postgres -d postgres -q)
"${P[@]}" -c "select pg_terminate_backend(pid) from pg_stat_activity where datname='pmreal' and pid<>pg_backend_pid()" >/dev/null
"${P[@]}" -c "drop database if exists pmreal" -c "create database pmreal template pmreal_base"
for k in OPENROUTER_API_KEY DEEPGRAM_API_KEY ELEVENLABS_API_KEY LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET; do export "$k=$(tr -d '[:space:]' < ~/.atiende-secrets/$k.txt)"; done
export VOZ_QA_DIR="$Q" VOZ_REP="$1" VOZ_FILTRO="$2" VOZ_ETQ="$3" VOZ_RES_DIR="$M/.voz-qa/results"
export VOZA_STACK="${VOZA_STACK:-elevenlabs}" VOZA_RUIDO="${VOZA_RUIDO:-4}"
export VOZA_CAMA_RESTAURANTE="${VOZA_CAMA_RESTAURANTE:-$HOME/atiende-loop/work/pm-cuenta-real/voz-stt-tts-nov/audio/noise_bed_restaurante_8k.wav}" VOZA_CAMA_COCINA_CALLE="${VOZA_CAMA_COCINA_CALLE:-$HOME/atiende-loop/work/pm-cuenta-real/voz-r2/noise_bed_cocina_calle_8k.wav}"
export VOZA_GRABAR_DIR="$M/.voz-qa/grabaciones" VOZA_GRABAR_N="${VOZA_GRABAR_N:-0}" VOZA_FALLAS_DIR="${VOZA_FALLAS_DIR:-$M/.voz-qa/grabaciones/fallas}"
cd "$Q" && nice -n 10 "$M/node_modules/.bin/vite-node" -c "$Q/vite-node.config.ts" "$M/scripts/voz-medicion-real-audio/${SCRIPT:-e2e-livekit.ts}"
echo "rc=$? $(date '+%T')"
