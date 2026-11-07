#!/usr/bin/env bash
# Verificacion manual, opt-in, contra un Postgres LOCAL real y EFIMERO. Acompaña a
# packages/domain-restaurantes/migrations/191_voz_turno_hilos.sql (hilo por llamada del turno de voz del cerebro v2 y resolucion del secreto de sucursal).
#
# Prueba, contra RLS/GRANT/CHECK/auth.uid() reales: el hilo solo lo lee y escribe la sesion de sistema (staff y anon no), update solo de las columnas
# del turno, sin delete directo, CHECK de formato, compare-and-swap por version, resolver_secreto (vigente, anterior en gracia, vencido, formato,
# solo sistema, otra organizacion) y la purga (solo sistema).
#
# Levanta un Postgres efimero y delega el veredicto en el gate generico (scripts/verify-real-postgres-ci/run-gate.mjs, el mismo del CI): cada escenario
# de assertions.sql se juzga por sus convenciones (`should_fail`, `..._deberia_ser_N`, error/exito) y el script SALE con codigo != 0 si alguno no
# se comporta como se espera: no hay que leer la salida de psql.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH y `node` (>= 22). Si falta algo, falla explicito en vez de fingir que corrio.
#
# Uso:  scripts/verify-restaurantes-voz-turno/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql node; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-restaurantes-voz-turno: falta '$bin' en PATH -- esta verificacion necesita Postgres local y node." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55698
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

echo "==> bootstrap + TODAS las migraciones reales (incluye 191) + escenarios, con veredicto automatico"
PGHOST="$WORKDIR" PGPORT="$PGPORT" PGUSER=postgres node "$REPO_ROOT/scripts/verify-real-postgres-ci/run-gate.mjs" "$HERE"
