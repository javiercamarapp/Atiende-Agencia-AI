#!/usr/bin/env bash
# Despliega apps/voice-worker en Fly.io: crea la app si no existe, carga las llaves como secretos de Fly (desde VARIABLES DE ENTORNO; nunca en argumentos ni en el
# repo) y hace `fly deploy`. Por omision es un ENSAYO (--dry-run): valida todo y muestra que haria, sin tocar Fly. Con --ejecutar aplica. Ver docs/VOZ-ACTIVACION.md.
#
#   bash scripts/voz/desplegar-worker.sh            # ensayo: solo nombres de variables, nunca valores
#   bash scripts/voz/desplegar-worker.sh --ejecutar # necesita `fly` instalado y FLY_API_TOKEN (o `fly auth login`)
#
# Variables obligatorias:  LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET ATIENDE_API_URL INTERNAL_SECRET GEMINI_API_KEY VOICE_DNIS_MAP
#                          + una variable por sucursal con el secreto que nombra `secretoEnv` dentro de VOICE_DNIS_MAP
# Opcionales:              OPENROUTER_API_KEY (escalon 2 de la escalera) VOICE_TOPE_MENSUAL_USD VOICE_COSTO_MAX_LLAMADA_USD GEMINI_BACKEND VERTEX_PROJECT VERTEX_LOCATION
#                          VERTEX_SERVICE_ACCOUNT_JSON FLY_APP (por omision atiende-voice-worker) FLY_ORG
set -euo pipefail

EJECUTAR=0
for arg in "$@"; do
  case "$arg" in
    --ejecutar) EJECUTAR=1 ;;
    --dry-run) EJECUTAR=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Argumento desconocido: $arg (usa --ejecutar o --dry-run)" >&2; exit 2 ;;
  esac
done

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="${FLY_APP:-atiende-voice-worker}"
ASSETS="${VOZ_ASSETS_DIR:-$RAIZ/apps/voice-worker/assets}"
FLY_BIN="${FLY_BIN:-fly}"

faltan=()
for v in LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET ATIENDE_API_URL INTERNAL_SECRET GEMINI_API_KEY VOICE_DNIS_MAP; do
  [ -n "${!v:-}" ] || faltan+=("$v")
done

# Los secretos por sucursal los nombra VOICE_DNIS_MAP (`secretoEnv`): se leen del entorno y se suben con ESE nombre.
SECRETOS_SUCURSAL=()
if [ -n "${VOICE_DNIS_MAP:-}" ]; then
  nombres="$(node -e '
    try {
      const m = JSON.parse(process.env.VOICE_DNIS_MAP);
      const n = new Set(Object.values(m).map((v) => v && v.secretoEnv).filter((s) => typeof s === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(s)));
      if (n.size === 0) process.exit(3);
      console.log([...n].join("\n"));
    } catch { process.exit(3); }
  ')" || { echo "VOICE_DNIS_MAP no es un JSON valido o ninguna entrada trae secretoEnv." >&2; exit 1; }
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    SECRETOS_SUCURSAL+=("$n")
    [ -n "${!n:-}" ] || faltan+=("$n (secreto de sucursal)")
  done <<< "$nombres"
fi

if [ "${#faltan[@]}" -gt 0 ]; then
  echo "Faltan variables de entorno (solo nombres; los valores nunca se imprimen):" >&2
  printf '  - %s\n' "${faltan[@]}" >&2
  exit 1
fi

# Los 15 pregrabados viven en la IMAGEN (se generan una vez, no se versionan: apps/voice-worker/assets/*.wav esta en .gitignore).
MENSAJES=(saludo_respaldo saludo_respaldo_dias saludo_respaldo_tardes saludo_respaldo_noches silencio_reprompt silencio_despedida pedir_repetir handoff aviso_duracion limite_duracion limite_costo tope_mensual proveedor_caido tool_timeout despedida)
sin_audio=()
for m in "${MENSAJES[@]}"; do
  [ -s "$ASSETS/$m.wav" ] || sin_audio+=("$m.wav")
done
if [ "${#sin_audio[@]}" -gt 0 ]; then
  echo "Faltan pregrabados en apps/voice-worker/assets/ (sin ellos el worker no contesta): corre npm run voz:pregrabados antes de desplegar." >&2
  printf '  - %s\n' "${sin_audio[@]}" >&2
  exit 1
fi

SECRETOS=(LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET ATIENDE_API_URL INTERNAL_SECRET GEMINI_API_KEY VOICE_DNIS_MAP "${SECRETOS_SUCURSAL[@]}")
for opc in OPENROUTER_API_KEY VOICE_TOPE_MENSUAL_USD VOICE_COSTO_MAX_LLAMADA_USD GEMINI_BACKEND VERTEX_PROJECT VERTEX_LOCATION VERTEX_SERVICE_ACCOUNT_JSON; do
  [ -z "${!opc:-}" ] || SECRETOS+=("$opc")
done

echo "App de Fly: $APP (region dfw, 1 maquina siempre encendida)"
echo "Secretos que se cargarian (${#SECRETOS[@]}): ${SECRETOS[*]}"
echo "Pregrabados: 15/15 en apps/voice-worker/assets/"

if [ "$EJECUTAR" -ne 1 ]; then
  echo "ENSAYO: no se toco Fly. Para aplicar: bash scripts/voz/desplegar-worker.sh --ejecutar"
  exit 0
fi

command -v "$FLY_BIN" >/dev/null 2>&1 || { echo "No se encontro \`$FLY_BIN\`: instalalo (https://fly.io/docs/flyctl/install/) y entra con \`fly auth login\` o FLY_API_TOKEN." >&2; exit 1; }

cd "$RAIZ"
if ! "$FLY_BIN" status -a "$APP" >/dev/null 2>&1; then
  echo "Creando la app $APP..."
  "$FLY_BIN" apps create "$APP" ${FLY_ORG:+--org "$FLY_ORG"}
fi

# Los valores viajan por la entrada estandar (`fly secrets import`), nunca como argumentos (se verian en `ps` y en el historial).
{
  for n in "${SECRETOS[@]}"; do
    printf '%s=%s\n' "$n" "$(node -e 'process.stdout.write(JSON.stringify(process.env[process.argv[1]] ?? ""))' "$n")"
  done
} | "$FLY_BIN" secrets import -a "$APP" --stage

"$FLY_BIN" deploy --config apps/voice-worker/fly.toml --dockerfile apps/voice-worker/Dockerfile --ignorefile apps/voice-worker/Dockerfile.dockerignore -a "$APP" --ha=false --strategy immediate
"$FLY_BIN" scale count 1 -a "$APP" --yes
"$FLY_BIN" status -a "$APP"
echo "Listo. El worker no expone servicio publico: comprueba el latido con \`$FLY_BIN checks list -a $APP\` (salud en 200) y \`$FLY_BIN logs -a $APP\` (busca worker_escuchando)."
