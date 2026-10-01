#!/usr/bin/env bash
# Prepara UNA base Postgres para el arnes de evaluacion del Copiloto: bootstrap minimo de plataforma, TODAS las
# migraciones reales (supabase/migrations/), el GRANT USAGE que en Supabase pone la plataforma y las semillas
# (scripts/eval-copiloto/seeds/*.sql). Mismo orden que scripts/verify-*/run.sh. Usa las variables estandar de psql
# (PGHOST/PGPORT/PGUSER/PGPASSWORD): en CI las da el servicio postgres del workflow; en local las pone run.sh.
# Uso: scripts/eval-copiloto/preparar.sh <nombre_de_base>   (la crea de cero: drop + create)
set -euo pipefail

DB="${1:?uso: preparar.sh <nombre_de_base>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

for bin in psql; do
  command -v "$bin" >/dev/null 2>&1 || { echo "eval-copiloto: falta '$bin' en PATH" >&2; exit 1; }
done

psql -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists ${DB};" -c "create database ${DB};"
export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -d "$DB" -v ON_ERROR_STOP=1 -q)

echo "==> bootstrap de plataforma (auth.uid()/roles)"
"${PSQL[@]}" -f "$HERE/sql/bootstrap.sql" >/dev/null
echo "==> migraciones reales de supabase/migrations/"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do "${PSQL[@]}" -f "$f" >/dev/null; done
echo "==> GRANT USAGE de schemas"
"${PSQL[@]}" -f "$HERE/sql/post-migrations.sql" >/dev/null
echo "==> semillas de las 6 verticales"
for f in "$HERE"/seeds/*.sql; do "${PSQL[@]}" -f "$f" >/dev/null; done
echo "==> base '$DB' lista"
