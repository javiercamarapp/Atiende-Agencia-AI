#!/usr/bin/env bash
# Verificacion manual, opt-in, contra un Postgres LOCAL real y EFIMERO. Acompaña a
# packages/domain-restaurantes/migrations/099_agregados_pedido_por_validar.sql (agregados a un pedido ya enviado: solicitud del agente
# que una persona de la sucursal acepta o rechaza, con SLA).
#
# Prueba, contra RLS/GRANT/CHECK/trigger/auth.uid() reales: lectura (staff con alcance, admin acotado, repartidor, cross-tenant, sistema, anon), creacion (solo
# sistema, mismo pedido y sucursal, un abierto por pedido), decision (compare-and-set, alcance, sin suplantacion, aceptar aplica al pedido), guardia contra
# manipular lo que pidio el cliente, bitacora append-only y la base sin migrar (SAVEPOINT).
#
# Levanta un Postgres efimero y delega el veredicto en el gate generico (scripts/verify-real-postgres-ci/run-gate.mjs, el mismo del CI): cada escenario
# de assertions.sql se juzga por sus convenciones (`should_fail`, `..._deberia_ser_N`, error/exito) y el script SALE con codigo != 0 si alguno no
# se comporta como se espera: no hay que leer la salida de psql.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH y `node` (>= 22). Si falta algo, falla explicito en vez de fingir que corrio.
#
# Uso:  scripts/verify-restaurantes-agregados/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-agregados: falta '$bin' en PATH -- esta verificacion necesita Postgres local y node." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55697
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "${WORKDIR:?}"
}
trap cleanup EXIT

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null

echo "==> arrancando Postgres efimero en el puerto $PGPORT"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

echo "==> bootstrap + TODAS las migraciones reales (incluye 099) + escenarios, con veredicto automatico"
PGHOST="$WORKDIR" PGPORT="$PGPORT" PGUSER=postgres node "$REPO_ROOT/scripts/verify-real-postgres-ci/run-gate.mjs" "$HERE"
