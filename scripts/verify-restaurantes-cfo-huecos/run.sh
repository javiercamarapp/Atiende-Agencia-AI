#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón que scripts/verify-restaurantes-cfo-ventas/run.sh. Prueba, con
# RLS/GRANT/auth.uid() reales (rol `authenticated`), las funciones restaurantes.cfo_* de
# packages/domain-restaurantes/migrations/084_cfo_huecos_frecuentes_p90_es_venta_forma_pago.sql (sobre la 081-083). Además aplica el archivo de la migración UNA SEGUNDA VEZ
# para probar que es idempotente.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Si no están, falla explícito.
# Uso:  scripts/verify-restaurantes-cfo-huecos/run.sh   (VERIFY_PGPORT=55684 por omisión)
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-cfo-huecos: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/cfo2.XXXXXX")"
PGPORT="${VERIFY_PGPORT:-55684}"
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
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR -c listen_addresses=" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden (incluye 081 a 084)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> idempotencia: aplicando 084_cfo_huecos_frecuentes_p90_es_venta_forma_pago.sql una SEGUNDA vez (debe terminar sin error)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$REPO_ROOT"/supabase/migrations/20240101000394_084_cfo_huecos_frecuentes_p90_es_venta_forma_pago.sql >/dev/null

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — los escenarios *_deberia_ser_N deben devolver ese valor y los should_fail terminar en ERROR (run-gate.mjs lo juzga automáticamente en CI)."
