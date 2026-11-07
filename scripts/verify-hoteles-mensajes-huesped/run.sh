#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón que scripts/verify-hoteles-conversaciones/run.sh.
# Ejercita la migración 046_hoteles_mensajes_huesped.sql (H-P3-03, paridad3): candidatos derivados del estado real, configuración por
# evento con RLS/GRANT por columna, idempotencia de la marca de envío, funciones de solo sistema, historial, cross-tenant, anon y la
# retención de conversaciones. Además corre la IDEMPOTENCIA CONCURRENTE (concurrencia.sh): varias conexiones simultáneas intentan
# emitir el mismo (referencia, evento) y exactamente UNA gana -- algo que un escenario begin/rollback de una sola conexión no puede probar.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH; si faltan falla explícito.
# Uso:  scripts/verify-hoteles-mensajes-huesped/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-hoteles-mensajes-huesped: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT="${VERIFY_PGPORT:-55641}"
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

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios de hoteles (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> idempotencia concurrente (ver concurrencia.sh)"
HOST="$WORKDIR" PORT="$PGPORT" DB=atiende_verify bash "$HERE/concurrencia.sh"

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"deberia_ser_N\"/\"should_fail\" deben terminar en N filas o ERROR (correcto), el resto debe devolver filas/RETURNING reales."
