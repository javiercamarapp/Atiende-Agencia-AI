#!/usr/bin/env bash
# Verificación manual, opt-in, de los repositorios TypeScript del CFO (CFO-05) contra un Postgres LOCAL real, con RLS/GRANT/auth.uid() reales y el
# rol `authenticated`. A diferencia de scripts/verify-restaurantes-cfo-{ventas,clientes-operacion,captura} (que prueban las funciones SQL con psql),
# aquí corre la prueba apps/api/tests/restaurantes-cfo-real-postgres.spec.ts: el adaptador PostgresCfoRepository, el ServicioCfo y las rutas
# `/admin/cfo/*` de punta a punta sobre las migraciones 081/082/083 REALES (bigint/numeric como string, NULL, SAVEPOINT, 22023/42501, base sin migrar).
#
# NO es un verify del gate de CI (run-gate.mjs solo descubre carpetas con bootstrap.sql + post-migrations.sql + assertions.sql): este directorio solo
# tiene run.sh y reutiliza el bootstrap de scripts/verify-restaurantes-cfo-ventas. Nunca toca el 5432 de Homebrew ni la base real: Postgres efímero,
# solo por socket unix, en un puerto propio (VERIFY_PGPORT, 55689 por omisión).
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Uso:  scripts/verify-restaurantes-cfo-repos/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-cfo-repos: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
BASE_VERIFY="$REPO_ROOT/scripts/verify-restaurantes-cfo-ventas"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/cfo5.XXXXXX")"
PORT="${VERIFY_PGPORT:-55689}"
if [ "$PORT" = "5432" ]; then
  echo "verify-restaurantes-cfo-repos: el puerto 5432 es el Postgres de Homebrew; usa otro VERIFY_PGPORT." >&2
  exit 1
fi
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null

echo "==> arrancando Postgres efímero en el puerto $PORT (solo socket unix)"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PORT -k $WORKDIR -c listen_addresses=" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PORT" -U postgres -d atiende_verify)

echo "==> mock mínimo de plataforma (auth.uid()/roles) y TODAS las migraciones reales de supabase/migrations/"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$BASE_VERIFY/bootstrap.sql" >/dev/null
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$BASE_VERIFY/post-migrations.sql" >/dev/null

echo "==> corriendo la prueba apps/api/tests/restaurantes-cfo-real-postgres.spec.ts (vitest, 2 workers)"
cd "$REPO_ROOT"
CFO_REAL_PG=1 PGHOST="$WORKDIR" PGPORT="$PORT" PGUSER=postgres PGDATABASE=atiende_verify \
  npx vitest run --config vitest.config.ts apps/api/tests/restaurantes-cfo-real-postgres.spec.ts --maxWorkers=2
