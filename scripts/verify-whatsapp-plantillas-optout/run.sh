#!/usr/bin/env bash
# Verificacion contra Postgres LOCAL real de PL-31/PL-32 (migracion 0048): catalogo de plantillas HSM por organizacion,
# opt-out por organizacion y ventana de 24 h de citas. Ver assertions.sql para los escenarios positivos, negativos
# (staff, otro tenant, sistema, anon) y SQLSTATE exacto.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Levanta un cluster Postgres efimero en un directorio temporal, aplica las
# migraciones reales de `supabase/migrations/` en orden, corre `assertions.sql` y lo apaga/borra al salir.
#
# Uso:  scripts/verify-whatsapp-plantillas-optout/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-whatsapp-plantillas-optout: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
# Puerto aleatorio (no fijo) -- varios verify-*/ pueden correr en paralelo en la
# misma máquina (otros constructores, ver AGENTS.md de esta tarea); un puerto
# fijo colisiona con cualquier otro cluster efímero ya escuchando.
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

echo "==> aplicando las migraciones reales de supabase/migrations/ en orden"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo '==> listo: los *_deberia_ser_N y los bloques DO con exception when sqlstate son la prueba real (el gate run-gate.mjs los evalua solo).'
