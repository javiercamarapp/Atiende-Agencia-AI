#!/usr/bin/env bash
# QA restaurantes R2 (lente caos): confirma en Postgres LOCAL EFIMERO (nunca la base real) R2-caos-01/02/03. Mismo arranque que
# scripts/verify-restaurantes-autopiloto/run.sh: bootstrap + TODAS las migraciones + fixtures/escenarios del autopiloto + qa.sql.
# Uso: scripts/verify-qa-r2-caos-restaurantes/run.sh   (pesado: correr con ~/atiende-loop/heavy.sh)
set -euo pipefail
for bin in initdb pg_ctl psql; do command -v "$bin" >/dev/null 2>&1 || { echo "falta '$bin' en PATH" >&2; exit 1; }; done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
AUTO="$REPO_ROOT/scripts/verify-restaurantes-autopiloto"
WORKDIR="$(mktemp -d)"
PGPORT=55661
PGDATA="$WORKDIR/pgdata"
cleanup() { pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true; rm -rf "$WORKDIR"; }
trap cleanup EXIT
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$WORKDIR/postgres.log" -o "-p $PGPORT -k $WORKDIR" start >/dev/null
psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$AUTO/bootstrap.sql" >/dev/null
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$AUTO/post-migrations.sql" >/dev/null
echo "==> fixtures y escenarios del autopiloto (salida omitida)"
"${PSQL_DB[@]}" -f "$AUTO/assertions.sql" >/dev/null 2>&1 || true
echo "==> escenarios QA R2 caos"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/qa.sql"
