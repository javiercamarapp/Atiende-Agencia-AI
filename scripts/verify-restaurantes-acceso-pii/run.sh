#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón EXACTO
# que scripts/verify-rentas-bitacora-auditoria/run.sh (ver ese archivo para el
# porqué de cada paso). Se agrega junto con
# packages/domain-restaurantes/migrations/097_acceso_pii_bitacora.sql para dejar,
# en el repo, la prueba reproducible de que restaurantes.audit_log/
# restaurantes.record_audit_log funcionan contra RLS/GRANT/auth.uid() reales -- el
# repositorio en memoria de domain-restaurantes nunca aplica ninguno de los tres,
# así que nunca podría detectar un hueco de este tipo.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente — en este
# entorno vienen con `brew install postgresql`). Si no están disponibles, este
# script falla explícito con un mensaje claro en vez de fingir que corrió algo.
#
# Uso:  scripts/verify-restaurantes-acceso-pii/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-acceso-pii: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55459
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

echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden (incluye 097_acceso_pii_bitacora.sql)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios de autorización (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> concurrencia: 4 sesiones simultaneas piden el mismo acceso (cada una retiene su transaccion 1 s). Con el candado los conteos son 1,2,3,4 distintos; sin el, todas veian 1."
OUT="$WORKDIR/conc"; mkdir -p "$OUT"
for i in 1 2 3 4; do
  "${PSQL_DB[@]}" -At -v ON_ERROR_STOP=1 -c "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true); select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e3', null); select pg_sleep(1); commit;" > "$OUT/$i.txt" 2>&1 &
done
wait
CONTEOS="$(grep -hE '^[0-9]+$' "$OUT"/*.txt | sort -n | tr '\n' ' ')"
echo "conteos devueltos: $CONTEOS"
if [ "$CONTEOS" = "1 2 3 4 " ]; then echo "CONCURRENCIA: PASS"; else echo "CONCURRENCIA: FAIL" >&2; exit 1; fi

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"should_fail\"/\"deberia_ser_0\" deben terminar en ERROR o 0 filas (correcto), el resto debe devolver filas/RETURNING reales."
