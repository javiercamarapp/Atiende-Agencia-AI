#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real — mismo patrón EXACTO
# que scripts/verify-flujos-sistema-2/run.sh (ver ese archivo y el README de este
# directorio para la metodología completa). Ejercita los recorridos de STAFF
# AUTENTICADO de hoteles (recepción, de punta a punta) + restaurantes + citas,
# incluido el fix real de:
#   * packages/domain-hoteles/migrations/025_reserva_lifecycle_staff_grants.sql
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Si no están disponibles, este script
# falla explícito en vez de fingir que corrió algo.
#
# Uso:
#   scripts/verify-flujos-staff/run.sh
#     Corre normal — aplica TODAS las migraciones reales, incluido el fix.
#
#   FLUJOS_STAFF_SKIP_FIX=1 scripts/verify-flujos-staff/run.sh
#     Aplica TODAS las migraciones EXCEPTO la de arriba — reproduce el estado
#     ANTES del fix, para documentar (README.md) que crear/transicionar una
#     reserva de hoteles de verdad fallaba contra Postgres real bajo sesión de
#     staff. Los escenarios de restaurantes/citas y los controles negativos/
#     cross-tenant/anon de hoteles no dependen del fix y deben seguir pasando
#     igual en este modo.
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-flujos-staff: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55464
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
SKIP_FIX="${FLUJOS_STAFF_SKIP_FIX:-0}"
SKIP_FILES=(
  "20240101000153_025_reserva_lifecycle_staff_grants.sql"
)

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

is_skip_file() {
  # OJO: usa `sf` (nunca `f`) como variable de este `for` -- un `for f in ...`
  # DENTRO de una función de bash reasigna PERMANENTEMENTE la `$f` del scope que
  # la llamó sin `local` (bug real documentado en scripts/verify-flujos-sistema/
  # run.sh). `local` es obligatorio aquí.
  local base="$1"
  local sf
  for sf in "${SKIP_FILES[@]}"; do
    [[ "$base" == "$sf" ]] && return 0
  done
  return 1
}

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null

echo "==> arrancando Postgres efímero en el puerto $PGPORT"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "create database atiende_verify_flujos_staff;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify_flujos_staff)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

if [[ "$SKIP_FIX" == "1" ]]; then
  echo "==> FLUJOS_STAFF_SKIP_FIX=1 — aplicando TODAS las migraciones EXCEPTO el fix de este PR (reproduce el estado ANTES del fix)"
else
  echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden"
fi
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$f")"
  if [[ "$SKIP_FIX" == "1" ]] && is_skip_file "$base"; then
    echo "    (omitida: $base)"
    continue
  fi
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios 1-22b, 23-37 (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"deberia_ser_N\"/\"should_fail\" deben terminar en N filas o ERROR (correcto), el resto debe devolver filas/RETURNING reales."
