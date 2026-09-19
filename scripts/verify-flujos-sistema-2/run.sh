#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real — mismo patrón EXACTO
# que scripts/verify-flujos-sistema/run.sh (ver ese archivo, y su README para el
# inventario completo de flujos de sistema de las 6 verticales). Ejercita los 3 fixes
# de este PR (segunda parte de esa misma serie -- "flujos de sistema bloqueados en
# escritura"):
#   * packages/domain-restaurantes/migrations/017_restaurantes_sistema_whatsapp_channel_config.sql
#   * packages/domain-despachos/migrations/009_despachos_sistema_cobranza_escritura.sql
#   * packages/domain-licitaciones/migrations/025_licitaciones_sistema_renovaciones_facturas.sql
#
# El 4o punto del inventario (hoteles night-audit/no-show -- `reservation`/`folio`/
# `rate_plan`/`tax_config`/`charge`/`payment`) quedó deliberadamente FUERA de este PR
# -- ver el README de este directorio, sección "Punto 4 (hoteles night-audit/no-show)
# -- NO arreglado, análisis". El escenario 21 de este script es el guard de regresión
# de ese límite (sigue bloqueado, igual que antes).
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Si no están disponibles, este script
# falla explícito en vez de fingir que corrió algo.
#
# Uso:
#   scripts/verify-flujos-sistema-2/run.sh
#     Corre normal — aplica TODAS las migraciones reales, incluidos los 3 fixes.
#
#   FLUJOS_SISTEMA_2_SKIP_FIX=1 scripts/verify-flujos-sistema-2/run.sh
#     Aplica TODAS las migraciones EXCEPTO las 3 de arriba — reproduce el estado
#     ANTES del fix, para poder documentar (README.md) que los escenarios de
#     restaurantes/despachos/licitaciones fallaban de verdad. Los escenarios de
#     aislamiento/anon/control negativo/límite deliberado no dependen del fix y deben
#     seguir pasando igual en este modo — sirve como control de que el modo --skip
#     realmente solo quita las 3 piezas relevantes, nada más.
#
# OJO (bug real encontrado y corregido en scripts/verify-flujos-sistema/run.sh, ver su
# `git log`): la función `is_skip_file` de abajo usa `local` para su variable de
# bucle (`sf`, nunca `f`) -- un `for f in ...` DENTRO de una función de bash reasigna
# PERMANENTEMENTE la `$f` del scope que la llamó (bash no da scope de bloque a la
# variable de un `for`, solo `local` lo hace explícito a nivel de función) -- sin
# `local`/un nombre distinto, el bucle principal de aplicación de migraciones de abajo
# quedaría "pegado" al ÚLTIMO valor de SKIP_FILES para el resto de la corrida.
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-flujos-sistema-2: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55462
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
SKIP_FIX="${FLUJOS_SISTEMA_2_SKIP_FIX:-0}"
SKIP_FILES=(
  "20240101000140_017_restaurantes_sistema_whatsapp_channel_config.sql"
  "20240101000141_009_despachos_sistema_cobranza_escritura.sql"
  "20240101000142_025_licitaciones_sistema_renovaciones_facturas.sql"
)

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

is_skip_file() {
  # OJO: usa `sf` (nunca `f`) como variable de este `for` -- ver el comentario de
  # cabecera de este archivo. `local` es obligatorio aquí.
  local base="$1"
  local sf
  for sf in "${SKIP_FILES[@]}"; do
    [[ "$base" == "$sf" ]] && return 0
  done
  return 1
}

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null

echo "==> arrancando Postgres efímero en el puerto $PGPORT"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "create database atiende_verify_2;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify_2)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

if [[ "$SKIP_FIX" == "1" ]]; then
  echo "==> FLUJOS_SISTEMA_2_SKIP_FIX=1 — aplicando TODAS las migraciones EXCEPTO los 3 fixes de este PR (reproduce el estado ANTES del fix)"
else
  echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden"
fi
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$f")"
  if [[ "$SKIP_FIX" == "1" ]] && is_skip_file "$base"; then
    echo "    (omitida: $base)"
    continue
  fi
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios de flujos de sistema (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"deberia_ser_N\"/\"should_fail\" deben terminar en N filas o ERROR (correcto), el resto debe devolver filas/RETURNING reales."
