#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón que scripts/verify-hoteles-motor-tarifas/run.sh.
# Ejercita la sección 4 de 045_hoteles_folio_cierre_carrera.sql (H-P3-04: arranque automático del día de housekeeping).
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Uso:  scripts/verify-hoteles-housekeeping-dia/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-hoteles-housekeeping-dia: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55612
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

psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> mock mínimo de plataforma + TODAS las migraciones reales de supabase/migrations/ + post-migrations"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> escenarios (assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql" 2>&1 | tee "$WORKDIR/assertions.out"
if grep -E "asercion fallida|esperaba SQLSTATE|^psql:.*ERROR" "$WORKDIR/assertions.out" >/dev/null 2>&1; then
  echo "verify-hoteles-housekeeping-dia: FALLO un escenario (ver arriba)" >&2
  exit 1
fi
echo ""
echo "==> listo — cada escenario *_deberia_ser_N debe devolver N y no debe aparecer 'asercion fallida'."
