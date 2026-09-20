#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real (f2-orden-total-
# bitacoras) — demuestra, con el SQL REAL de las migraciones 011 (despachos), 028
# (hoteles) y 026 (licitaciones), que el desempate por `seq` da un orden TOTAL
# determinista para las 3 bitácoras de esta fase, incluso cuando varias filas se
# escriben en la MISMA transacción (created_at idéntico). Mismo patrón EXACTO que
# `scripts/verify-rentas-bitacora-auditoria/run.sh` (leído primero como plantilla):
# Postgres efímero real vía `initdb`/`pg_ctl`, todas las migraciones reales de
# `supabase/migrations/` aplicadas en orden.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente — en este
# entorno vienen con `brew install postgresql`). Si no están disponibles, este script
# falla explícito con un mensaje claro en vez de fingir que corrió algo.
#
# Uso:  scripts/verify-audit-log-orden-total-f2/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-audit-log-orden-total-f2: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55435
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

echo "==> aplicando las migraciones reales de supabase/migrations/ en orden (incluidas 011/028/026, dueñas de la columna seq de esta fase)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: escenarios 1-2 (despachos.audit_log), 3-4 (hoteles.fraude_audit_log) y 5-6 (licitaciones.tender_audit_log) confirman, para cada tabla, que varias filas escritas en la MISMA transacción comparten created_at y que 'order by created_at desc, seq desc' las ordena en el orden EXACTO de escritura, con paginación por offset estable (sin repetir ni perder filas)."
