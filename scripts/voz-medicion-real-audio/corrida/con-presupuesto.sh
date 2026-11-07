#!/usr/bin/env bash
# Corre correr-el.sh solo si OpenRouter >= OR_MIN (por omision 30.6: tope 30 USD + margen de una corrida de 6 llamadas) y ElevenLabs >= EL_MIN (62k: tope 60k + margen).
K=$(tr -d '[:space:]' < ~/.atiende-secrets/OPENROUTER_API_KEY.txt); E=$(tr -d '[:space:]' < ~/.atiende-secrets/ELEVENLABS_API_KEY.txt)
or=$(curl -s https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $K" | python3 -c 'import json,sys;d=json.load(sys.stdin)["data"];print(round(d["total_credits"]-d["total_usage"],3))')
el=$(curl -s https://api.elevenlabs.io/v1/user/subscription -H "xi-api-key: $E" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["character_limit"]-d["character_count"])')
echo "presupuesto OR=$or EL=$el"
python3 -c "import sys; sys.exit(0 if float('$or')>=float('${OR_MIN:-30.6}') and int('$el')>=int('${EL_MIN:-62000}') else 1)" || { echo "PRESUPUESTO_INSUFICIENTE"; exit 4; }
[ "${1:-}" = "--solo-revisar" ] && exit 0
exec bash "$(dirname "$0")/correr-el.sh" "$@"
