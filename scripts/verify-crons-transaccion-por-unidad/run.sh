#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón
# EXACTO que scripts/verify-outbox-grants/run.sh (leído primero como plantilla).
# Demuestra el mecanismo de Postgres detrás del hallazgo de auditoría a1b #1
# (ALTA)/#2 (MEDIA), corregido en TypeScript por este PR -- ver el comentario de
# cabecera de assertions.sql para el detalle completo.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Si no están disponibles, este
# script falla explícito en vez de fingir que corrió algo.
#
# Uso:  scripts/verify-crons-transaccion-por-unidad/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-crons-transaccion-por-unidad: falta '$bin' en PATH -- instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55471
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

"${PSQL[@]}" -d postgres -c "create database atiende_verify_crons_txn;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify_crons_txn)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles) + el schema demo propio de este script"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

echo "==> aplicando las migraciones reales de supabase/migrations/ en orden (este verify no depende de ninguna en particular -- ver comentario de cabecera de assertions.sql)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando GRANT sobre el schema demo a authenticated (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo los 5 escenarios (ver assertions.sql) -- 1/3 demuestran el mecanismo, 2/4/5 verifican el conteo real"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo -- revisa arriba: escenario 2 debe dar 0 (antes del fix se pierde TODO), escenario 4 debe dar 2 (después del fix A y C persisten), escenario 5 debe dar 0 (B nunca persiste, en ningún patrón)."
