#!/usr/bin/env bash
# Simulacion de un mes de un hotel sintetico contra un Postgres EFIMERO (initdb + pg_ctl locales; se destruye al salir).
# Patron de scripts/eval-copiloto/run.sh. NUNCA toca la base real, Vercel, secretos ni llamadas pagadas: el unico Postgres es el
# efimero, WhatsApp/PAC/pagos/LLM son dobles locales y cualquier fetch a un host sin doble falla (la guarda cubre solo globalThis.fetch) (ver main.ts).
#
# Uso:
#   scripts/simular-mes-hoteles/run.sh            # modo corto: 3 dias (el de CI, job opcional)
#   scripts/simular-mes-hoteles/run.sh --dias=30  # mes completo (a mano; guarda docs/qa/<fecha>-simulacion-mes-hoteles/)
#   scripts/simular-mes-hoteles/run.sh --dias=30 --salida=docs/qa/2026-10-03-simulacion-mes-hoteles
# Sale con codigo distinto de 0 si falla CUALQUIER assert duro.
set -euo pipefail

for bin in initdb pg_ctl psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "simular-mes-hoteles: falta '$bin' en PATH (brew install postgresql)" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# SIM_DEV_DIR=<carpeta> (solo desarrollo del simulador): conserva el cluster y una base `plantilla` ya migrada entre corridas
# (migrar 265 archivos tarda ~90 s). Sin esa variable todo es efimero y se destruye al salir.
if [[ -n "${SIM_DEV_DIR:-}" ]]; then
  WORKDIR="$SIM_DEV_DIR"
  mkdir -p "$WORKDIR"
else
  WORKDIR="$(mktemp -d)"
fi
PGDATA="$WORKDIR/pgdata"
PGPORT_SIM="${SIM_HOTELES_PGPORT:-55474}"
DB="atiende_simulacion_hoteles"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  [[ -n "${SIM_DEV_DIR:-}" ]] || rm -rf "$WORKDIR"
}
trap cleanup EXIT

[[ -f "$PGDATA/PG_VERSION" ]] || { echo "==> initdb en $PGDATA"; initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null; }
echo "==> Postgres efimero en el puerto $PGPORT_SIM (un solo Postgres a la vez)"
pg_ctl -D "$PGDATA" -l "$WORKDIR/postgres.log" -o "-p $PGPORT_SIM -k $WORKDIR -c shared_buffers=64MB -c max_connections=60 -c listen_addresses=''" start >/dev/null

export PGHOST="$WORKDIR" PGPORT="$PGPORT_SIM" PGUSER=postgres PGOPTIONS="-c client_min_messages=warning"

migrar() {
  local base="$1"
  psql -d postgres -v ON_ERROR_STOP=1 -q -c "create database ${base};"
  local PSQL=(psql -d "$base" -v ON_ERROR_STOP=1 -q)
  echo "==> bootstrap de plataforma (auth.uid()/roles)"
  "${PSQL[@]}" -f "$HERE/sql/bootstrap.sql" >/dev/null
  echo "==> TODAS las migraciones reales de supabase/migrations/"
  for f in "$REPO_ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f" >/dev/null; done
  echo "==> GRANT USAGE de schemas (lo que en Supabase hace la plataforma)"
  "${PSQL[@]}" -f "$HERE/sql/post-migrations.sql" >/dev/null
}

if [[ -n "${SIM_DEV_DIR:-}" ]]; then
  if ! psql -d postgres -tAc "select 1 from pg_database where datname='plantilla'" | grep -q 1; then migrar plantilla; fi
  psql -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists ${DB};" -c "create database ${DB} template plantilla;"
else
  migrar "$DB"
fi

export SIM_DATABASE_URL="postgresql://postgres@localhost/${DB}?host=${WORKDIR}&port=${PGPORT_SIM}"
cd "$REPO_ROOT"
npx vite-node scripts/simular-mes-hoteles/main.ts -- "$@"
