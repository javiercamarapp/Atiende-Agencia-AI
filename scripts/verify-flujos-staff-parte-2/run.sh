#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real — mismo patrón EXACTO
# que scripts/verify-flujos-staff/run.sh (Parte 1). Ejercita los recorridos de STAFF
# AUTENTICADO de rentas (statement de propietario + payout) + despachos (cierre
# mensual + cartera de cobranza) + licitaciones (decisión go/no-go + aprobación de
# documento de empresa) — las 3 verticales que Parte 1 dejó pendientes — más el
# endurecimiento de #151 sobre hoteles.availability:
#   * packages/domain-hoteles/migrations/026_availability_column_level_update_grant.sql
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Si no están disponibles, este script
# falla explícito en vez de fingir que corrió algo.
#
# Uso:
#   scripts/verify-flujos-staff-parte-2/run.sh
#     Corre normal — aplica TODAS las migraciones reales, incluido el endurecimiento.
#
#   FLUJOS_STAFF_PARTE2_SKIP_FIX=1 scripts/verify-flujos-staff-parte-2/run.sh
#     Aplica TODAS las migraciones EXCEPTO la de arriba — reproduce el estado ANTES
#     del endurecimiento, para documentar (README.md) que un staff con acceso a una
#     property SÍ podía, antes de este PR, hacer un UPDATE directo de
#     hoteles.availability.total_rooms por PostgREST (GRANT de tabla completa). Los
#     escenarios de rentas/despachos/licitaciones y book_availability/
#     release_availability (que nunca tocan total_rooms) no dependen de este fix y
#     deben seguir pasando igual en este modo.
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-flujos-staff-parte-2: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55465
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
SKIP_FIX="${FLUJOS_STAFF_PARTE2_SKIP_FIX:-0}"
SKIP_FILES=(
  "20240101000154_026_availability_column_level_update_grant.sql"
)

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

is_skip_file() {
  # Mismo bug documentado en scripts/verify-flujos-staff/run.sh: usa `sf` (nunca `f`)
  # como variable de este `for` -- un `for f in ...` DENTRO de una función de bash
  # reasigna PERMANENTEMENTE la `$f` del scope que la llamó sin `local`. `local` es
  # obligatorio aquí.
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

"${PSQL[@]}" -d postgres -c "create database atiende_verify_flujos_staff_parte2;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify_flujos_staff_parte2)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

if [[ "$SKIP_FIX" == "1" ]]; then
  echo "==> FLUJOS_STAFF_PARTE2_SKIP_FIX=1 — aplicando TODAS las migraciones EXCEPTO el endurecimiento de este PR (reproduce el estado ANTES del endurecimiento)"
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

echo "==> corriendo fixtures + escenarios (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"deberia_ser_N\"/\"should_fail\" deben terminar en N filas o ERROR (correcto), el resto debe devolver filas/RETURNING reales."
