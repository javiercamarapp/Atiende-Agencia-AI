#!/usr/bin/env bash
# Verificacion manual, opt-in, contra un Postgres LOCAL real -- mismo patron que
# scripts/verify-search-path-hardening-core/run.sh. Acompana a
# packages/db/migrations/0035_search_path_triggers_append_only.sql
# (`alter function ... set search_path` para 3 funciones marcadas por el
# advisor "Function Search Path Mutable"): deja la prueba reproducible de que
# `pg_proc.proconfig` quedo fijado y de que el comportamiento no cambio (ver
# assertions.sql). En CI lo corre run-gate.mjs automaticamente.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Uso: scripts/verify-search-path-triggers-append-only/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-search-path-triggers-append-only: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55490
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

echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden (incluye 0035_search_path_triggers_append_only.sql)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de los schemas de dominio (post-migrations.sql) (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo la verificación de proconfig + comportamiento (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo -- los escenarios *_deberia_ser_N deben devolver ese valor y los should_fail terminar en ERROR (run-gate.mjs lo juzga automaticamente en CI)"
