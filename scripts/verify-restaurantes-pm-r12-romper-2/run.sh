#!/usr/bin/env bash
# R12 "romper" ronda 2 contra un Postgres LOCAL real y efimero (initdb/pg_ctl), mismo patron que scripts/verify-restaurantes-qa-seguridad-r2/run.sh.
# Solo PRUEBAS: no toca ninguna migracion ni la base real.
#
#   1. assertions.sql      -> el gate (lo corre tambien run-gate.mjs en CI): debe terminar sin ERROR de psql.
#   2. hallazgos-abiertos.sql -> informe ABIERTO / CORREGIDO de los defectos de la capa SQL (no falla el script).
#
# Uso:  scripts/verify-restaurantes-pm-r12-romper-2/run.sh
#       (en macOS con TMPDIR largo: TMPDIR=/tmp scripts/verify-restaurantes-pm-r12-romper-2/run.sh; el socket de Postgres tiene tope de 103 caracteres)
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-pm-r12-romper-2: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
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

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null

echo "==> arrancando Postgres efímero en el puerto $PGPORT"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

PSQL=(psql -X -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -X -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> mock mínimo de plataforma (auth.uid()/roles)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

echo "==> migraciones reales de supabase/migrations/ en orden"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1
done

echo "==> USAGE de schema para authenticated/anon (post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> gate: assertions.sql (los escenarios con deberia_ser_N deben devolver N; ningun ERROR de psql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> hallazgos abiertos de la capa SQL (informativo; ABIERTO = el defecto se reproduce)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=0 -f "$HERE/hallazgos-abiertos.sql" 2>&1 | grep -E "ABIERTO|CORREGIDO" | sed -E 's/^psql:[^ ]+ NOTICE:  //' || true
