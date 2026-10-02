#!/usr/bin/env bash
# Verificacion manual, opt-in, contra un Postgres LOCAL real -- mismo patron EXACTO que
# scripts/verify-superadmin-resumen/run.sh. Acompana a
# `packages/db/migrations/0044_superadmin_corridas_y_panel_agentes.sql` (bitacora de corridas y panel de agentes):
# demuestra contra GRANT/RLS reales que la escritura de corridas y la purga son solo-sistema, que las lecturas atan
# `p_caller_id` a `auth.uid()`, que ningun rol (ni anon) toca las tablas directo, que la redaccion del error se
# aplica en la base y que el exito/costo de 30 dias cuadran con las filas sembradas. Los repositorios en memoria
# nunca aplican GRANT ni RLS, asi que no podrian detectar ese hueco por si solos.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Si faltan, falla explicito en vez de fingir que corrio algo.
#
# Uso:  scripts/verify-superadmin-agentes/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-superadmin-agentes: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55581
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

echo "==> aplicando las migraciones reales de supabase/migrations/ en orden"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema core a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios de autorización (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: los escenarios marcados 'RECHAZADO'/'should_fail' deben terminar en ERROR o en 0/valor-cero (correcto), el resto debe devolver datos reales."
