#!/usr/bin/env bash
# Verificación opt-in contra un Postgres LOCAL real (mismo patrón que
# scripts/verify-cfdi-folio-reservation-rls/run.sh). En CI corre vía
# scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto por los 3 archivos).
#
# Uso:
#   scripts/verify-security-definer-revoke/run.sh
#   DEFINER_REVOKE_SKIP_FIX=1 scripts/verify-security-definer-revoke/run.sh   # estado ANTES del fix (1-7 fallan)
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-security-definer-revoke: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55834
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
SKIP_FIX="${DEFINER_REVOKE_SKIP_FIX:-0}"
SKIP_RE='_((0091_security_definer|051_hoteles_security_definer|042_licitaciones_security_definer|038_rentas_security_definer)_revoke_public|202_restaurantes_catalogo_publico_policy_por_rol)\.sql$'

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
  if [[ "$SKIP_FIX" == "1" && "$(basename "$f")" =~ $SKIP_RE ]]; then
    echo "    (omitida: $(basename "$f"))"
    continue
  fi
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> escenarios (assertions.sql)"
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"
