#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón EXACTO
# que scripts/verify-restaurantes-config-staff-baja/run.sh (ver ese archivo para el
# porqué de cada paso). Cubre, contra RLS/GRANT/auth.uid() reales (nunca el
# repositorio en memoria, que no aplica ninguno de los tres):
#   - packages/domain-licitaciones/migrations/027_organization_timezone.sql
#     (`licitaciones.tenant_config`, FASE 3 -- zona horaria por negocio)
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente — en este
# entorno vienen con `brew install postgresql`). Si no están disponibles, este
# script falla explícito con un mensaje claro en vez de fingir que corrió algo.
#
# Uso:  scripts/verify-licitaciones-zona-horaria/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-licitaciones-zona-horaria: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
# Puerto aleatorio (mismo criterio que verify-citas-whatsapp-config-sesion-sistema/
# run.sh) -- varios verify-*/ corren en paralelo entre distintos constructores en
# esta Mac; un puerto fijo colisionaría con otro run.sh activo al mismo tiempo.
PGPORT=$(( (RANDOM % 20000) + 40000 ))
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

echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden (incluye 027_organization_timezone.sql)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios de autorización (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"should_fail\"/\"deberia_ser_0\"/\"deberia_ser_null\" deben terminar en ERROR o 0 filas/NULL (correcto), el resto debe devolver filas/RETURNING reales."
