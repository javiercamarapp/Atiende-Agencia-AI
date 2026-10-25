#!/usr/bin/env bash
# Verificacion contra Postgres LOCAL real de las migraciones 090 (perfil operativo) y 100 (lectura del perfil previo). Mismo patron que
# scripts/verify-restaurantes-permisos-accion/run.sh (reusa su bootstrap). Requiere initdb/pg_ctl/psql en PATH.
set -euo pipefail
for bin in initdb pg_ctl psql; do command -v "$bin" >/dev/null 2>&1 || { echo "falta '$bin' en PATH" >&2; exit 1; }; done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
BASE="$REPO_ROOT/scripts/verify-restaurantes-permisos-accion"
WORKDIR="$(mktemp -d)"; PGPORT=55932; PGDATA="$WORKDIR/pgdata"
trap 'pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true; rm -rf "$WORKDIR"' EXIT
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$WORKDIR/postgres.log" -o "-p $PGPORT -k $WORKDIR" start >/dev/null
psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d postgres -c "create database atiende_verify;" >/dev/null
P=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)
"${P[@]}" -v ON_ERROR_STOP=1 -f "$BASE/bootstrap.sql" >/dev/null
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do "${P[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null; done
"${P[@]}" -v ON_ERROR_STOP=1 -f "$BASE/post-migrations.sql" >/dev/null
"${P[@]}" -q -v ON_ERROR_STOP=1 -f "$HERE/assertions.sql" 2>&1 | grep -E "PASS|FAIL|ERROR"
