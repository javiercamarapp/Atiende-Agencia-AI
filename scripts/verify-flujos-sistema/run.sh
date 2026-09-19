#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real — mismo patrón EXACTO
# que scripts/verify-core-rls-sesion-sistema/run.sh (ver ese archivo). Ejercita los
# 2 fixes de este PR ("flujos de sistema bloqueados en escritura"):
#   * supabase/migrations/20240101000137_024_licitaciones_sistema_ingesta_escritura.sql
#   * supabase/migrations/20240101000139_022_hoteles_sistema_voz_whatsapp_escritura.sql
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Si no están disponibles, este script
# falla explícito en vez de fingir que corrió algo.
#
# Uso:
#   scripts/verify-flujos-sistema/run.sh
#     Corre normal — aplica TODAS las migraciones reales, incluidos los 2 fixes.
#
#   FLUJOS_SISTEMA_SKIP_FIX=1 scripts/verify-flujos-sistema/run.sh
#     Aplica TODAS las migraciones EXCEPTO las 2 de arriba — reproduce el estado
#     ANTES del fix, para poder documentar (README.md) que los escenarios de
#     licitaciones/hoteles fallaban de verdad. Los escenarios de aislamiento/anon/
#     control negativo no dependen del fix y deben seguir pasando igual en este
#     modo — sirve como control de que el modo --skip realmente solo quita las 2
#     piezas relevantes, nada más.
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-flujos-sistema: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55459
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
SKIP_FIX="${FLUJOS_SISTEMA_SKIP_FIX:-0}"
SKIP_FILES=(
  "20240101000137_024_licitaciones_sistema_ingesta_escritura.sql"
  "20240101000139_022_hoteles_sistema_voz_whatsapp_escritura.sql"
)

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

is_skip_file() {
  # OJO: usa `sf` (nunca `f`) como variable de este `for` -- un `for f in
  # ...` aquí reasignaría PERMANENTEMENTE la `$f` del loop principal de
  # aplicación de migraciones (bash no da scope propio a la variable de un
  # `for` dentro de una función), dejando "pegado" el ÚLTIMO valor de
  # SKIP_FILES para el resto de la corrida -- bug real, encontrado corriendo
  # este script de verdad (ver `git log` de este archivo).
  local base="$1"
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

"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

if [[ "$SKIP_FIX" == "1" ]]; then
  echo "==> FLUJOS_SISTEMA_SKIP_FIX=1 — aplicando TODAS las migraciones EXCEPTO los 2 fixes de este PR (reproduce el estado ANTES del fix)"
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
