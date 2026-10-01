#!/usr/bin/env bash
# Corre un comando contra un Postgres EFIMERO ya migrado y sembrado (initdb + pg_ctl locales; se destruye al salir).
# Exporta COPILOTO_EVAL_DATABASE_URL (socket local, sin contrasena) para el comando.
# Uso: scripts/eval-copiloto/run.sh npx vite-node scripts/eval-copiloto/congelar.ts -- --check
set -euo pipefail

for bin in initdb pg_ctl psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "eval-copiloto: falta '$bin' en PATH (brew install postgresql)" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGDATA="$WORKDIR/pgdata"
PGPORT_EVAL="${COPILOTO_EVAL_PGPORT:-55461}"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> initdb + Postgres efimero en el puerto $PGPORT_EVAL"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$WORKDIR/postgres.log" -o "-p $PGPORT_EVAL -k $WORKDIR -c shared_buffers=64MB -c max_connections=60 -c listen_addresses=''" start >/dev/null

export PGHOST="$WORKDIR" PGPORT="$PGPORT_EVAL" PGUSER=postgres
bash "$HERE/preparar.sh" atiende_eval_copiloto

export COPILOTO_EVAL_DATABASE_URL="postgresql://postgres@localhost/atiende_eval_copiloto?host=${WORKDIR}&port=${PGPORT_EVAL}"
cd "$REPO_ROOT"
"$@"
