#!/usr/bin/env bash
# Arma el directorio de trabajo del arnes (<dest>) desde arnes/ del repo. Uso: preparar-qa.sh <dest> [original|alineado]
# original (por omision): copia tal cual (los archivos efectivos son byte a byte los de arnes/). alineado: ademas aplica corpus-alineado/aplicar.py
# sobre la COPIA (arnes/ del repo nunca se modifica). Sin red ni llaves.
set -euo pipefail
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:?falta <dest>}"; CORPUS="${2:-original}"
[[ "$CORPUS" == original || "$CORPUS" == alineado ]] || { echo "CORPUS invalido: $CORPUS"; exit 8; }
mkdir -p "$DEST"
for f in "$AQUI"/arnes/*.ts.txt; do cp "$f" "$DEST/$(basename "${f%.txt}")"; done
cp "$AQUI"/arnes/*.sql "$AQUI"/arnes/cargar-config.py "$DEST/"; rm -rf "$DEST/real-dump"; cp -R "$AQUI/arnes/real-dump" "$DEST/real-dump"
echo '{"type":"module","private":true}' > "$DEST/package.json"
[ "$CORPUS" = alineado ] && python3 -I "$AQUI/corpus-alineado/aplicar.py" "$DEST"
exit 0
