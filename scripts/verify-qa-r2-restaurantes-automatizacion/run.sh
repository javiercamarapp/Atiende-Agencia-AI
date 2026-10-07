#!/usr/bin/env bash
# QA adversarial R2 (lente automatizacion), restaurantes. Verificacion opt-in contra un Postgres LOCAL EFIMERO con TODAS las
# migraciones reales de supabase/migrations/ (mismo patron que scripts/verify-restaurantes-autopiloto). Nunca toca la base real.
#
# Cada escenario imprime `RESULTADO <id> OK|DEFECTO <detalle>`. Un DEFECTO es la reproduccion de un hallazgo del reporte
# work/qa/restaurantes/ronda-2-automatizacion.md; cuando se corrija, el mismo escenario debe pasar a OK.
#
# Uso:  bash scripts/verify-qa-r2-restaurantes-automatizacion/run.sh   (sale 0 aunque haya DEFECTO; sale !=0 solo si el arnes falla)
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-qa-r2-restaurantes-automatizacion: falta '$bin' en PATH (brew install postgresql)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55911
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
echo "==> arrancando Postgres efimero en el puerto $PGPORT (TZ del servidor = UTC, como Supabase)"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR -c timezone=UTC" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null
echo "==> aplicando TODAS las migraciones reales de supabase/migrations/"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> escenarios (assertions.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -At -f "$HERE/assertions.sql"
echo "==> listo"
