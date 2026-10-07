#!/usr/bin/env bash
# Carga de rentas (Rn-P3-14) contra un Postgres EFIMERO ya migrado (initdb + pg_ctl locales; se destruye al salir). Manual o nocturno,
# fuera de CI. Requiere Postgres instalado (brew install postgresql). NO la corras en paralelo con otros procesos pesados: con N completo
# abre decenas de conexiones.
#   scripts/load-rentas/run.sh              # N reducido
#   scripts/load-rentas/run.sh --completo   # N completo (A 50x3, B 30x5 rondas, C 50x10)
set -euo pipefail

for bin in initdb pg_ctl psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "load-rentas: falta '$bin' en PATH (brew install postgresql)" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGDATA="$WORKDIR/pgdata"
PORT="${LOAD_RENTAS_PGPORT:-55471}"
DB=atiende_load_rentas

cleanup() {
  pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> initdb + Postgres efimero en el puerto $PORT"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$WORKDIR/postgres.log" -o "-p $PORT -k $WORKDIR -c shared_buffers=128MB -c max_connections=120 -c listen_addresses=''" start >/dev/null
export PGHOST="$WORKDIR" PGPORT="$PORT" PGUSER=postgres
psql -X -q -d postgres -v ON_ERROR_STOP=1 -c "create database $DB;"
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$REPO_ROOT/scripts/verify-rentas-concurrencia/bootstrap.sql" >/dev/null
echo "==> aplicando las migraciones reales de supabase/migrations/"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1
done
psql -X -q -d "$DB" -v ON_ERROR_STOP=1 -f "$REPO_ROOT/scripts/verify-rentas-concurrencia/post-migrations.sql" >/dev/null

export LOAD_RENTAS_DATABASE_URL="postgresql://postgres@localhost/$DB?host=${WORKDIR}&port=${PORT}"
cd "$REPO_ROOT"
npx vite-node scripts/load-rentas/run.ts -- "$@"
