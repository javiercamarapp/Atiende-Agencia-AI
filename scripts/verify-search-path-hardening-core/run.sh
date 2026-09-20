#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón
# EXACTO que scripts/verify-superadmin-impersonacion/run.sh (ver ese archivo
# para el porqué de cada paso). Se agrega junto con
# packages/db/migrations/0023_search_path_hardening_core_functions.sql (Fase 2
# de endurecimiento: `set search_path` fijo para 4 funciones de `core` que
# carecían de él -- WARN "Function Search Path Mutable" de `get_advisors`) para
# dejar, en el repo, la prueba reproducible de que `pg_proc.proconfig` incluye
# `search_path=core, pg_temp` tras la migración, y de que el comportamiento de
# cada función (positivo/negativo) es idéntico al que tenía antes -- ver
# assertions.sql para el detalle de cada escenario.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente --
# en este entorno vienen con `brew install postgresql`). Si no están
# disponibles, este script falla explícito con un mensaje claro en vez de
# fingir que corrió algo.
#
# Uso:  scripts/verify-search-path-hardening-core/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-search-path-hardening-core: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55467
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null

echo "==> arrancando Postgres efímero en el puerto $PGPORT"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden (incluye 0023_search_path_hardening_core_functions.sql)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema core a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo la verificación de proconfig + comportamiento (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: \"deberia_ser_4\"/\"deberia_ser_100000000\"/\"deberia_ser_hoteles\"/\"deberia_ser_1\" deben devolver ese valor exacto, y las filas marcadas \"should_fail\" deben terminar en ERROR (correcto, comportamiento sin cambios)."
