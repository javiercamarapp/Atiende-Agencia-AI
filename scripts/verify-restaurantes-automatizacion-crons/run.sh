#!/usr/bin/env bash
# Lote QA R1 automatizacion (restaurantes), migracion 046: escenarios contra un Postgres LOCAL EFIMERO real.
# Mismo patron que scripts/verify-restaurantes-pedidos-programados/run.sh. Nunca toca la base real.
#
# Uso:  scripts/verify-restaurantes-automatizacion-crons/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-automatizacion-crons: falta '$bin' en PATH (instala Postgres local)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=$(( (RANDOM % 20000) + 40000 ))
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR -c listen_addresses=''" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

echo "==> gate de escenarios (aplica bootstrap + todas las migraciones reales y corre assertions.sql)"
PGHOST="$WORKDIR" PGPORT="$PGPORT" PGUSER=postgres PGPASSWORD=x node "$REPO_ROOT/scripts/verify-real-postgres-ci/run-gate.mjs" "$HERE"
