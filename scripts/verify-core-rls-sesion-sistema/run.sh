#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real — mismo patrón EXACTO
# que scripts/verify-restaurantes-sql/run.sh (ver ese archivo). Ejercita el fix de
# `packages/db/migrations/0015_core_rls_sesion_sistema.sql` (espejo
# `supabase/migrations/20240101000136_...`): las policies de SELECT de
# `core.organization`/`core.property` no tenían escape hatch de sesión de sistema.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Si no están disponibles, este script
# falla explícito en vez de fingir que corrió algo.
#
# Uso:
#   scripts/verify-core-rls-sesion-sistema/run.sh
#     Corre normal — aplica TODAS las migraciones reales, incluido el fix.
#
#   CORE_RLS_SKIP_FIX=1 scripts/verify-core-rls-sesion-sistema/run.sh
#     Aplica TODAS las migraciones EXCEPTO
#     20240101000136_0015_core_rls_sesion_sistema.sql — reproduce el estado ANTES
#     del fix, para poder documentar (README.md) que los escenarios 1-8 fallaban de
#     verdad. Los escenarios 9-15 (aislamiento/anon/límite deliberado) no dependen
#     del fix y deben seguir pasando igual en este modo — sirve como control de que
#     el modo --skip realmente solo quita la pieza relevante, nada más.
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-core-rls-sesion-sistema: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55458
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
SKIP_FIX="${CORE_RLS_SKIP_FIX:-0}"
SKIP_FILE="20240101000136_0015_core_rls_sesion_sistema.sql"

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

if [[ "$SKIP_FIX" == "1" ]]; then
  echo "==> CORE_RLS_SKIP_FIX=1 — aplicando TODAS las migraciones EXCEPTO $SKIP_FILE (reproduce el estado ANTES del fix)"
else
  echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden"
fi
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$f")"
  if [[ "$SKIP_FIX" == "1" && "$base" == "$SKIP_FILE" ]]; then
    echo "    (omitida: $base)"
    continue
  fi
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios de core RLS de sesión de sistema (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"deberia_ser_N\"/\"should_fail\" deben terminar en N filas o ERROR (correcto), el resto debe devolver filas/RETURNING reales."
