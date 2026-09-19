#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real — reproduce el
# hallazgo de la auditoría a2b (CRÍTICO): "el drenado inline de WhatsApp aborta la
# transacción de negocio en sesión de staff" (ver assertions.sql para el mecanismo
# completo, ANTES/DESPUÉS del hotfix de SAVEPOINT). Copia adaptada de
# scripts/verify-correo-inline-sesion-staff/run.sh (mismo primo de bug, mismo
# hotfix, cerrado en PR #166 para correo).
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente — en
# este entorno vienen con `brew install postgresql`). Si no están disponibles,
# este script falla explícito con un mensaje claro en vez de fingir que corrió
# algo.
#
# Uso:  scripts/verify-whatsapp-inline-sesion-staff/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-whatsapp-inline-sesion-staff: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55434
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

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios ANTES/DESPUES (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: los 3 escenarios *_antes_*_deberia_ser_0 y los 3 *_despues_*_deberia_ser_1 son la prueba real del bug y del fix."
