#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real (f2-despachos-fiscal-
# deadline-unique) — demuestra, con el SQL REAL de `packages/domain-despachos/src/
# postgres-repository.ts::createDeadline` (copiado literal abajo, no reescrito de
# memoria), que pulsar "Calcular vencimientos" dos veces para el mismo periodo YA NO
# duplica filas ni lanza un error crudo. Mismo patrón EXACTO que
# `scripts/verify-despachos-fechas-postgres-real/` (leído primero como plantilla):
# Postgres efímero real vía `initdb`/`pg_ctl`, todas las migraciones reales de
# `supabase/migrations/` aplicadas en orden.
#
# Hallazgo que este verify confirma (ver el cuerpo del PR para la evidencia completa):
# `despachos.fiscal_deadline` YA tiene `unique (property_id, tipo, periodo)` desde la
# migración ORIGINAL de la Fase 1 (`supabase/migrations/20240101000009_001_despachos_
# schema.sql`, nunca se agregó ni se quitó después) — este verify NO aplica ninguna
# migración nueva para el índice (no hacía falta ninguna), solo ejerce el SQL del
# repositorio contra el esquema real tal cual ya vive en `supabase/migrations/`.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente — en este
# entorno vienen con `brew install postgresql`). Si no están disponibles, este script
# falla explícito con un mensaje claro en vez de fingir que corrió algo.
#
# Uso:  scripts/verify-despachos-fiscal-deadline-unique/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-despachos-fiscal-deadline-unique: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
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

echo "==> aplicando las migraciones reales de supabase/migrations/ en orden (incluida 001_despachos_schema.sql, dueña del índice unique -- este verify no agrega ninguna migración nueva)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: el escenario 1 confirma que el índice unique ya existe (sin migración nueva); el escenario 2 ('debe fallar') reproduce el bug ORIGINAL (INSERT plano, unique_violation crudo); los escenarios 3-5 ejercen el SQL REAL de createDeadline (ON CONFLICT DO NOTHING) y confirman que la segunda llamada para el mismo periodo NO duplica y NO lanza; el escenario 6 es el canario negativo del fallback 42P10."
