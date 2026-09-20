#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real — mismo patrón exacto que
# scripts/verify-rentas-cron-rls/run.sh. NO forma parte de `npm test`/CI local; SÍ
# corre automáticamente en cada PR/push vía scripts/verify-real-postgres-ci/run-gate.mjs
# (.github/workflows/postgres-real-gate.yml).
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente — en este
# entorno vienen con `brew install postgresql`). Si no están disponibles, este script
# falla explícito con un mensaje claro en vez de fingir que corrió algo.
#
# Uso:  scripts/verify-rentas-ical-import-postgres-real/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-rentas-ical-import-postgres-real: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
# Hallazgo de revisión de PR #175 (no bloqueante): 55434 ya lo usa
# scripts/verify-superadmin-caller-binding/run.sh -- solo afecta corridas LOCALES
# simultáneas de ambos scripts (CI usa run-gate.mjs, que ya serializa/aísla cada
# gate), pero 55472 no colisiona con ningún otro `scripts/verify-*/run.sh` del repo.
PGPORT=55472
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

echo "==> corriendo fixtures + escenarios de upsertEventoImportado (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: el escenario 1 debe terminar en ERROR (documenta el NOT NULL real); los \"deberia_ser_N\" deben devolver exactamente N."
