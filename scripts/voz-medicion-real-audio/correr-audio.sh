#!/usr/bin/env bash
# Uso: correr-audio.sh <rep> [filtro-regex-de-id] [etiqueta]   (Postgres efimero en el puerto 55497 ya arriba; no lo levanta)
# Variables utiles: VOZA_RUIDO=0|1|2|3  VOZA_TOPE_USD  VOZA_TOPE_AUDIO_S  VOZA_TOPE_LLAMADA_S  VOZ_CORTE_USD  VOZ_RES_DIR  QA_DIR_VOZ (por omision ../../../voz-ejec/qa)
HERE="$(cd "$(dirname "$0")" && pwd)"; WT="$(cd "$HERE/../.." && pwd)"
QA="${QA_DIR_VOZ:-$WT/../voz-ejec/qa}"; QA="$(cd "$QA" && pwd)"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/.local/pg17/bin:$PATH" NODE_OPTIONS=--max-old-space-size=3072
export OPENROUTER_API_KEY="$(tr -d '[:space:]' < ~/.atiende-secrets/OPENROUTER_API_KEY.txt)"
export VOZ_QA_DIR="$QA" VOZ_REP="${1:-1}" VOZ_FILTRO="$2" VOZ_ETQ="${3:-audio}"
cd "$QA" && nice -n 15 "$WT/node_modules/.bin/vite-node" -c "$QA/vite-node.config.ts" "$HERE/ejecutar-audio.ts"
