#!/usr/bin/env bash
# Regla de oro de los lotes 0-10 del rediseno ds3: los specs SOLO se agregan. Falla si el diff contra la base modifica, borra o
# renombra algun archivo *.spec.* (los specs existentes siguen custodiando produccion hasta el flip) o si un spec nuevo trae
# `.skip` / `.only` / `.fixme`-sin-nota. Corre en CI para PRs con la etiqueta `ds3` (.github/workflows/capturas-ds3.yml).
#
# Uso: bash scripts/diseno/solo-agrega-specs.sh [base]     (base por omision: origin/main)
set -euo pipefail

base="${1:-origin/main}"
cd "$(git rev-parse --show-toplevel)"

if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  echo "solo-agrega-specs: no existe la base '$base' (haz git fetch origin main)" >&2
  exit 2
fi

# --no-renames: un spec renombrado aparece como borrado (D) + agregado (A) y falla igual.
cambios="$(git diff --no-renames --name-status "$base"...HEAD -- '*.spec.*' || true)"
malos="$(printf '%s\n' "$cambios" | awk 'NF && $1 != "A"')"

# Excepciones documentadas (ruta | commit/PR | razon). Para esos archivos solo se admite un diff que quite marcas.
lista="${DS3_EXCEPCIONES_SPECS:-$(dirname "$0")/excepciones-specs.txt}"
exceptuado() {
  [ -f "$lista" ] || return 1
  awk -F'|' -v f="$1" '/^[[:space:]]*#/ || NF < 3 {next} {r=$1; gsub(/^[ \t]+|[ \t]+$/, "", r); if (r == f) found=1} END {exit found ? 0 : 1}' "$lista"
}
if [ -n "$malos" ]; then
  restantes=""
  while IFS=$'\t' read -r estado ruta; do
    [ -z "$estado" ] && continue
    if [ "$estado" = "M" ] && exceptuado "$ruta"; then
      quitadas="$(git diff --no-renames -U0 "$base"...HEAD -- "$ruta" | grep -E '^-[^-]' | sed 's/^-//' || true)"
      agregadas="$(git diff --no-renames -U0 "$base"...HEAD -- "$ruta" | grep -E '^\+[^+]' | sed 's/^+//' || true)"
      if printf '%s\n' "$quitadas" | grep -vE '^[[:space:]]*//' | grep -E '\bexpect\b' >/dev/null; then
        restantes="$restantes$estado\t$ruta (excepcion: elimina un expect)\n"
      elif printf '%s\n' "$quitadas" | grep -vE '^[[:space:]]*(//|test\.fail\()' | grep -q .; then
        restantes="$restantes$estado\t$ruta (excepcion: elimina algo que no es test.fail ni comentario)\n"
      elif printf '%s\n' "$agregadas" | grep -vE '^[[:space:]]*//' | grep -q .; then
        restantes="$restantes$estado\t$ruta (excepcion: agrega algo que no es un comentario)\n"
      else
        echo "solo-agrega-specs: excepcion documentada aplicada a $ruta (solo quita marcas)" >&2
      fi
    else
      restantes="$restantes$estado\t$ruta\n"
    fi
  done <<< "$malos"
  malos="$(printf '%b' "$restantes" | awk 'NF')"
fi

if [ -n "$malos" ]; then
  echo "solo-agrega-specs: este PR modifica, borra o renombra specs existentes (solo se permiten archivos nuevos; excepciones en scripts/diseno/excepciones-specs.txt):" >&2
  printf '%s\n' "$malos" | sed 's/^/  /' >&2
  exit 1
fi

# Specs nuevos: nada de skip/only en las lineas agregadas.
prohibidos="$(git diff --no-renames -U0 "$base"...HEAD -- '*.spec.*' \
  | grep -E '^\+[^+]' | grep -E '\b(test|it|describe)\.(skip|only)\b|\b(xit|xdescribe|fit|fdescribe)\(' || true)"
if [ -n "$prohibidos" ]; then
  echo "solo-agrega-specs: los specs nuevos no pueden usar skip/only:" >&2
  printf '%s\n' "$prohibidos" | sed 's/^/  /' >&2
  exit 1
fi

total="$(printf '%s\n' "$cambios" | awk 'NF' | wc -l | tr -d ' ')"
echo "solo-agrega-specs: OK ($total spec(s) nuevo(s), ninguno modificado ni borrado, salvo excepciones documentadas)"
