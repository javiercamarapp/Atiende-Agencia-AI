#!/usr/bin/env bash
# Matriz E2E de voz: por bloque (condicion x rep) corre correr-el.sh (espera carga <= CARGA_MAX (10) sostenida y sin otra medicion; revisa presupuesto OR>=30.6 / EL>=62k).
# uso: SHA_ESPERADO=<sha corto> ETQ=r3 REPS="1 2 3 4 5" CONDS="1 4 5" bash matriz-r2.sh
# Reintenta una vez el bloque si quedaron excepciones (el arnes continua donde se quedo). Para todo si el presupuesto no alcanza (rc 4).
set -u
D=$(cd "$(dirname "$0")" && pwd); M=$(cd "$D/../../.." && pwd); cd "$M"; E=${ETQ:-r3}
F='^(VZ01|VZ02|VZ04|VZ05|P08|P14)$'
bloque() { # <ruido> <rep> <etiqueta> [krisp]
  local c=$1 r=$2 e=$3 k=${4:-}
  for intento in 1 2; do
    local sha; sha=$(git -C "$M" rev-parse --short HEAD)
    [ "$sha" != "${SHA_ESPERADO:-$sha}" ] && { echo "ALTO_SHA cambio la cabeza del worktree: $sha (esperado $SHA_ESPERADO)"; exit 5; }
    [ -n "$(git -C "$M" status --porcelain --untracked-files=no)" ] && { echo "ALTO_SHA el worktree tiene cambios sin commit"; exit 5; }
    echo "=== $(date '+%F %T') bloque $e rep$r intento $intento sha=$sha carga_max=${CARGA_MAX:-8}"
    if [ -n "$k" ]; then VOZ_RUIDO_KRISP=$k SCRIPT=e2e-livekit.ts VOZA_RUIDO=$c bash "$D/correr-el.sh" "$r" "$F" "$e"; else SCRIPT=e2e-livekit.ts VOZA_RUIDO=$c bash "$D/correr-el.sh" "$r" "$F" "$e"; fi
    local rc=$?
    [ $rc -eq 4 ] && { echo "ALTO_PRESUPUESTO $e rep$r"; exit 4; }
    python3 - "$M/.voz-qa/results/voz-e2e-$e-rep$r.json" <<'PYEOF' && break
import json,sys
try: rs=json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
sys.exit(0 if len([x for x in rs if not x.get("excepcion")])>=6 else 1)
PYEOF
  done
}
for r in ${REPS:-1 2 3 4 5}; do for c in ${CONDS:-1 4 5}; do bloque $c $r $E-c$c; done; done
[ -n "${SINKRISP:-}" ] && for r in 1 2 3; do bloque 4 $r $E-c4-sinkrisp ninguno; done
echo "MATRIZ_FIN $(date '+%F %T')"
