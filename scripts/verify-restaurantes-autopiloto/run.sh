#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón que
# scripts/verify-restaurantes-audit-log/run.sh. Prueba, con RLS/GRANT/auth.uid() reales, las tablas y funciones de
# packages/domain-restaurantes/migrations/050_autopiloto_aprobaciones_y_estados.sql (autopiloto de restaurantes (aprobaciones, estados sin clic, handoff, agotados)).
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente — en este
# entorno vienen con `brew install postgresql`). Si no están disponibles, este
# script falla explícito con un mensaje claro en vez de fingir que corrió algo.
#
# Uso:  scripts/verify-restaurantes-autopiloto/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-autopiloto: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55650
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

echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden (incluye 050_autopiloto_aprobaciones_y_estados.sql)"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios de autorización (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> concurrencia: dos conexiones aprueban la MISMA solicitud a la vez (una aplica, la otra espera el bloqueo y recibe el resultado ya resuelto)"
ORG=00000000-0000-0000-0000-0000000e5001
STF=00000000-0000-0000-0000-0000000e5013
SOL=00000000-0000-0000-0000-0000000e5103
ORD=00000000-0000-0000-0000-0000000e5da3
conexion() {
  "${PSQL_DB[@]}" -At -v ON_ERROR_STOP=1 <<SQL
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$STF', true);
select aplicado from restaurantes.solicitud_resolver('$ORG', '$SOL', 'aprobar', null);
select pg_sleep($1);
commit;
SQL
}
conexion 2 > "$WORKDIR/c1.out" &
P1=$!
sleep 0.7
conexion 0 > "$WORKDIR/c2.out" &
P2=$!
wait "$P1" "$P2"
APLICADOS=$(cat "$WORKDIR/c1.out" "$WORKDIR/c2.out" | grep -c '^t$' || true)
NO_APLICADOS=$(cat "$WORKDIR/c1.out" "$WORKDIR/c2.out" | grep -c '^f$' || true)
TRANSICIONES=$("${PSQL_DB[@]}" -At -c "select count(*) from restaurantes.order_status_events where order_id = '$ORD' and from_status = 'por_aprobar' and to_status = 'pending'")
echo "    aplicadas=$APLICADOS no_aplicadas=$NO_APLICADOS transiciones_en_historial=$TRANSICIONES (esperado 1 / 1 / 1)"
if [ "$APLICADOS" != "1" ] || [ "$NO_APLICADOS" != "1" ] || [ "$TRANSICIONES" != "1" ]; then
  echo "FALLO: la concurrencia de aprobar no dejo exactamente un efecto." >&2
  exit 1
fi

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"should_fail\"/\"deberia_ser_0\" deben terminar en ERROR o 0 filas (correcto), el resto debe devolver filas/RETURNING reales."
