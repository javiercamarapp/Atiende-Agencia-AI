#!/usr/bin/env bash
# Verificación contra un Postgres LOCAL real de la clase de defecto «función de SOLO sistema llamada con la sesión del staff»
# (8-oct-2026: «Probar agente» del panel respondía «Error interno» al primer mensaje: `restaurantes.consume_api_rate_limit` lanza 42501 si
# `auth.uid()` no es nulo y la ruta la llamaba dentro de `dbSession`). Dos partes:
#   1. assertions.sql: las funciones con el rol `authenticated` y `request.jwt.claim.sub` reales (rechazo al staff, topes 41.º / 401.º con la sesión
#      de sistema, aislamiento) -- es lo que corre el gate de CI (`run-gate.mjs`).
#   2. apps/api/tests/restaurantes-agente-preview-pg-real.spec.ts: la RUTA HTTP real (authMiddleware + dbSession + requirePropertyMembership) con
#      el motor de producción (`openManagedPostgres`) y el repositorio de Postgres: el primer mensaje NO da 500, el 41.º da 429, el 401.º de la
#      organización da 429, y lo mismo para el preview de voz.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH y las dependencias de node del repo. Levanta un cluster efímero en un puerto ALTO (nunca 5432): fija
# VERIFY_PGPORT para elegirlo (por omisión uno aleatorio entre 56000 y 60999). No toca ninguna base existente ni dato real.
#
# Uso:  scripts/verify-restaurantes-agente-preview-rate-limit/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-agente-preview-rate-limit: falta '$bin' en PATH." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d /tmp/pgprev.XXXXXX)"
PGPORT="${VERIFY_PGPORT:-$(( (RANDOM % 5000) + 56000 ))}"
if [ "$PGPORT" -le 55000 ]; then
  echo "verify-restaurantes-agente-preview-rate-limit: VERIFY_PGPORT debe ser > 55000 (recibido $PGPORT)." >&2
  exit 1
fi
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
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR -c listen_addresses=127.0.0.1" start >/dev/null

PSQL=(psql -q -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)
"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=("${PSQL[@]}" -d atiende_verify)

echo "==> mock mínimo de plataforma (auth.uid()/roles) + TODAS las migraciones reales de supabase/migrations/ en orden"
"${PSQL_DB[@]}" -f "$HERE/bootstrap.sql" >/dev/null 2>&1
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -f "$f" >/dev/null 2>&1 || { echo "falló la migración $f" >&2; exit 1; }
done
"${PSQL_DB[@]}" -f "$HERE/post-migrations.sql" >/dev/null

echo "==> 1/2 escenarios SQL (assertions.sql)"
echo ""
psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify -f "$HERE/assertions.sql"

echo ""
echo "==> 2/2 la ruta HTTP real contra este Postgres (rol authenticated + auth.uid() del staff)"
cd "$REPO_ROOT"
VERIFY_PGURL="postgres://postgres@127.0.0.1:$PGPORT/atiende_verify" npx vitest run apps/api/tests/restaurantes-agente-preview-pg-real.spec.ts --maxWorkers=2

echo ""
echo "==> listo — en la parte 1 los escenarios 1-3, 13 y 15 deben mostrar ERROR (es el rechazo esperado) y el resto devolver los *_deberia_ser_N indicados; la parte 2 debe pasar completa."
