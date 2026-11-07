#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real — mismo patrón que
# scripts/verify-core-rls-sesion-sistema/run.sh. Ejercita
# packages/mcp-servers/cfdi/migrations/002_folio_stamp_reservation_rls.sql.
# En CI corre solo vía scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto).
#
# Uso:
#   scripts/verify-cfdi-folio-reservation-rls/run.sh
#   FOLIO_RLS_SKIP_FIX=1 scripts/verify-cfdi-folio-reservation-rls/run.sh   # estado ANTES del fix (1, 6, 7, 8, 9 y 11 fallan)
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-cfdi-folio-reservation-rls: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55630
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
SKIP_FIX="${FOLIO_RLS_SKIP_FIX:-0}"
SKIP_FILE="20240101000630_002_folio_stamp_reservation_rls.sql"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> mock de plataforma + migraciones reales + post-migrations"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  if [[ "$SKIP_FIX" == "1" && "$(basename "$f")" == "$SKIP_FILE" ]]; then
    echo "    (omitida: $SKIP_FILE)"
    continue
  fi
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> escenarios (assertions.sql)"
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"
