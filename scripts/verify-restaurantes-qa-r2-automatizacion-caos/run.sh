#!/usr/bin/env bash
# Verificacion manual, opt-in, contra un Postgres LOCAL EFIMERO (nunca la base real): levanta initdb/pg_ctl y corre el MISMO gate que el CI
# (scripts/verify-real-postgres-ci/run-gate.mjs) sobre este directorio: bootstrap + TODAS las migraciones reales + assertions.sql con su
# veredicto por escenario (sale != 0 si algun escenario no se comporta como el archivo documenta).
# Uso:  bash scripts/verify-restaurantes-qa-r2-automatizacion-caos/run.sh   (pesado: correr con ~/atiende-loop/heavy.sh)
set -euo pipefail

for bin in initdb pg_ctl psql node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-qa-r2-automatizacion-caos: falta '$bin' en PATH (brew install postgresql)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55976
PGDATA="$WORKDIR/pgdata"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$WORKDIR/postgres.log" -o "-p $PGPORT -k $WORKDIR -c timezone=UTC" start >/dev/null
PGHOST="$WORKDIR" PGPORT="$PGPORT" PGUSER=postgres PGPASSWORD=postgres \
  node "$REPO_ROOT/scripts/verify-real-postgres-ci/run-gate.mjs" "scripts/verify-restaurantes-qa-r2-automatizacion-caos"
