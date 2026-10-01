#!/usr/bin/env bash
# PL-12. Envoltorio MANUAL de `vercel rollback` para Javier. Ver docs/ROLLBACK.md (plan, checklist y limites).
#
# Reglas de diseno:
# - SIN secretos: no lee ni escribe tokens. Usa la sesion local del CLI de Vercel (`vercel login`), que vive en
#   tu maquina y nunca en el repo ni en GitHub Actions.
# - Solo manual: se niega a ejecutarse si detecta CI (CI=true / GITHUB_ACTIONS). Ningun workflow lo llama.
# - Seguro por defecto: sin --ejecutar solo IMPRIME el comando; con --ejecutar pide escribir ROLLBACK a mano.
# - No toca la base de datos: `vercel rollback` solo cambia a que despliegue apunta el dominio de Produccion.
#
# Uso:
#   scripts/rollback/rollback.sh listar                          # ultimos despliegues de Produccion
#   scripts/rollback/rollback.sh a <url-o-id-del-despliegue>     # muestra el comando (no ejecuta)
#   scripts/rollback/rollback.sh a <url-o-id-del-despliegue> --ejecutar
#   scripts/rollback/rollback.sh estado                          # `vercel rollback status`
#   Variable opcional: ROLLBACK_SCOPE=<equipo>  (se pasa como --scope; no es un secreto)
set -euo pipefail

uso() { sed -n '/^# Uso:/,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "rollback.sh: es una herramienta MANUAL; se niega a correr en CI." >&2
  exit 2
fi

cmd="${1:-}"
[ -n "$cmd" ] || { uso; exit 2; }
shift || true

vercel_cli() {
  if [ -n "${ROLLBACK_SCOPE:-}" ]; then vercel "$@" --scope "$ROLLBACK_SCOPE"; else vercel "$@"; fi
}

case "$cmd" in
  listar)
    command -v vercel >/dev/null || { echo "Falta el CLI de Vercel (npm i -g vercel) y 'vercel login'." >&2; exit 2; }
    vercel_cli ls --prod
    ;;
  estado)
    command -v vercel >/dev/null || { echo "Falta el CLI de Vercel (npm i -g vercel) y 'vercel login'." >&2; exit 2; }
    vercel_cli rollback status
    ;;
  a)
    destino="${1:-}"
    [ -n "$destino" ] || { echo "Falta el despliegue destino (url o id)." >&2; uso; exit 2; }
    shift || true
    # Solo hostname de Vercel (sin esquema ni rutas) o id dpl_...: evita pasar texto arbitrario al CLI.
    if ! printf '%s' "$destino" | grep -Eq '^(dpl_[A-Za-z0-9]+|[A-Za-z0-9][A-Za-z0-9.-]*\.vercel\.app)$'; then
      echo "Destino invalido: '$destino'. Usa el id (dpl_...) o el hostname *.vercel.app de 'listar'." >&2
      exit 2
    fi
    ejecutar=0
    for arg in "$@"; do
      case "$arg" in
        --ejecutar) ejecutar=1 ;;
        *) echo "Argumento desconocido: $arg" >&2; exit 2 ;;
      esac
    done
    echo "Comando: vercel rollback $destino${ROLLBACK_SCOPE:+ --scope $ROLLBACK_SCOPE}"
    if [ "$ejecutar" -ne 1 ]; then
      echo "(simulacion: no se ejecuto nada; agrega --ejecutar para hacerlo)"
      exit 0
    fi
    command -v vercel >/dev/null || { echo "Falta el CLI de Vercel (npm i -g vercel) y 'vercel login'." >&2; exit 2; }
    printf 'Esto cambia el despliegue de PRODUCCION. Escribe ROLLBACK para continuar: '
    read -r confirmacion
    [ "$confirmacion" = "ROLLBACK" ] || { echo "Cancelado."; exit 1; }
    vercel_cli rollback "$destino"
    echo "Siguiente paso: verifica con 'npm run smoke:post-deploy -- https://<tu-dominio>' y sigue el checklist de docs/ROLLBACK.md."
    ;;
  *)
    uso
    exit 2
    ;;
esac
