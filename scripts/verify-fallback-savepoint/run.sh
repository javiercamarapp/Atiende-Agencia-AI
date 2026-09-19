#!/usr/bin/env bash
# Verificación automática, contra un Postgres LOCAL real (mismo patrón initdb/pg_ctl
# que scripts/verify-caller-binding-fase3/run.sh — ver su comentario de cabecera),
# del mecanismo COMPLETO que motiva runWithSavepointFallback
# (packages/db/src/savepoint-fallback.ts): sin SAVEPOINT, un error dentro de una
# transacción la deja abortada (25P02 en cualquier consulta posterior) y un COMMIT
# sobre esa transacción abortada NO lanza error -- devuelve el tag ROLLBACK; con
# SAVEPOINT, el camino de respaldo corre de verdad y el COMMIT es real.
#
# A diferencia del resto de scripts/verify-*/ de este repo, este NO sigue el
# contrato genérico de scripts/verify-real-postgres-ci/run-gate.mjs (bootstrap.sql +
# post-migrations.sql + assertions.sql, TODO envuelto en begin;...rollback;) por dos
# razones que ese framework no puede cubrir:
#   1. Necesita ver el tag de comando de un COMMIT REAL (el framework genérico
#      siempre envuelve en rollback -- un COMMIT real nunca ocurre ahí).
#   2. El escenario 3 (23514 de citas) necesita la base SIN la migración 019
#      aplicada -- el framework genérico aplica SIEMPRE todas las migraciones.
# Por eso este script hace su PROPIO pass/fail (grep sobre la salida real de psql,
# entre marcadores \echo de pg-scenarios.sql) y se invoca como un paso APARTE del
# job "Postgres real (gate)" en .github/workflows/postgres-real-gate.yml — ver ese
# archivo para cómo queda integrado al gate de CI.
#
# Los tres archivos SQL de este directorio se llaman pg-bootstrap.sql/
# pg-post-migrations.sql/pg-scenarios.sql (NUNCA bootstrap.sql/post-migrations.sql/
# assertions.sql a secas) a propósito: `run-gate.mjs::discoverVerifyDirs` detecta
# exactamente esos tres nombres y los correría con SU parser genérico (que asume
# begin;...rollback; en cada escenario) — ya pasó una vez con el primer push de
# este PR, el job "Postgres real (gate)" existente recogió este directorio y
# falló. Ver README.md de este directorio para el detalle completo.
#
# Uso:  scripts/verify-fallback-savepoint/run.sh
set -uo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-fallback-savepoint: falta '$bin' en PATH -- instala Postgres localmente para correr esta verificación." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55437
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
OUT="$WORKDIR/assertions-output.log"

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null

echo "==> arrancando Postgres efímero en el puerto $PGPORT"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify_fallback_savepoint)
psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "create database atiende_verify_fallback_savepoint;" >/dev/null

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/pg-bootstrap.sql" >/dev/null

echo "==> aplicando supabase/migrations/*.sql EXCEPTO la migración 019 (calendar_sync_error_visibility) -- a propósito: el escenario 3 necesita el CHECK VIEJO, la base ~30 migraciones atrás real que este PR corrige"
skipped=0
applied=0
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$f")"
  if [[ "$base" == *"_019_calendar_sync_error_visibility.sql" ]]; then
    echo "    SKIP (a propósito): $base"
    skipped=$((skipped + 1))
    continue
  fi
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
  applied=$((applied + 1))
done
if [ "$skipped" -ne 1 ]; then
  echo "verify-fallback-savepoint: se esperaba saltar EXACTAMENTE 1 migración (019_calendar_sync_error_visibility), se saltaron $skipped -- ¿cambió el nombre del archivo?" >&2
  exit 1
fi
echo "    $applied migraciones aplicadas, $skipped saltada a propósito"

echo "==> otorgando USAGE de schema citas/core a authenticated/anon"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/pg-post-migrations.sql" >/dev/null

echo "==> corriendo pg-scenarios.sql (una sola sesión -- para que BEGIN/COMMIT reales se vean de verdad)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/pg-scenarios.sql" >"$OUT" 2>&1
# ON_ERROR_STOP=1 en la CONEXIÓN psql general (bootstrap/migraciones) pero
# pg-scenarios.sql tiene su PROPIO `\set ON_ERROR_STOP off` en la primera línea --
# los ERROR de los escenarios 1/3a (deliberados) no deben tumbar el resto del
# archivo. La bandera de arriba (-v ON_ERROR_STOP=1) solo aplica antes de que
# pg-scenarios.sql corra su propio \set, así que queda anulada dentro del archivo --
# psql respeta el \set MÁS RECIENTE.

fail=0
check_between() {
  local start_marker="$1" end_marker="$2" expected_pattern="$3" description="$4"
  local slice
  slice="$(sed -n "/$start_marker/,/$end_marker/p" "$OUT")"
  if echo "$slice" | grep -qE "$expected_pattern"; then
    echo "   [PASS] $description"
  else
    fail=1
    echo "   [FAIL] $description -- no se encontró /$expected_pattern/ entre $start_marker y $end_marker"
    echo "          --- salida real ---"
    echo "$slice" | sed 's/^/          /'
  fi
}
check_between_absent() {
  local start_marker="$1" end_marker="$2" forbidden_pattern="$3" description="$4"
  local slice
  slice="$(sed -n "/$start_marker/,/$end_marker/p" "$OUT")"
  if echo "$slice" | grep -qE "$forbidden_pattern"; then
    fail=1
    echo "   [FAIL] $description -- se encontró /$forbidden_pattern/ (NO debía aparecer) entre $start_marker y $end_marker"
    echo "          --- salida real ---"
    echo "$slice" | sed 's/^/          /'
  else
    echo "   [PASS] $description"
  fi
}

echo ""
echo "=== verificando escenario 1 (SIN SAVEPOINT) ==="
check_between "MARCA-ESCENARIO-1-INICIO" "MARCA-ESCENARIO-1-FIN" "ERROR:.*division by zero" "el error deliberado (1/0) SÍ ocurrió"
check_between "MARCA-ESCENARIO-1-INICIO" "MARCA-ESCENARIO-1-FIN" "ERROR:.*current transaction is aborted" "la consulta de 'respaldo' sin SAVEPOINT falla con 25P02 (transacción abortada)"
check_between "MARCA-ESCENARIO-1-INICIO" "MARCA-ESCENARIO-1-FIN" "^ROLLBACK$" "el COMMIT final NO lanza error -- imprime el tag ROLLBACK, no COMMIT"
check_between_absent "MARCA-ESCENARIO-1-INICIO" "MARCA-ESCENARIO-1-FIN" "^COMMIT$" "el COMMIT final NUNCA imprime el tag COMMIT (la transacción SÍ quedó abortada)"
check_between "MARCA-ESCENARIO-1-VERIFICACION-INICIO" "MARCA-ESCENARIO-1-VERIFICACION-FIN" "ERROR:.*does not exist" "la tabla temporal NUNCA persistió -- TODA la transacción se revirtió, CREATE TABLE incluido"

echo ""
echo "=== verificando escenario 2 (CON SAVEPOINT) ==="
check_between "MARCA-ESCENARIO-2-INICIO" "MARCA-ESCENARIO-2-FIN" "ERROR:.*division by zero" "el mismo error deliberado SÍ ocurrió"
check_between "MARCA-ESCENARIO-2-INICIO" "MARCA-ESCENARIO-2-FIN" "^ROLLBACK$" "ROLLBACK TO SAVEPOINT corrió (psql lo imprime como tag ROLLBACK, es la recuperación esperada)"
check_between "MARCA-ESCENARIO-2-INICIO" "MARCA-ESCENARIO-2-FIN" "^INSERT 0 1$" "el camino de respaldo (segundo INSERT) SÍ corrió -- la sesión quedó recuperada, sin 25P02"
check_between "MARCA-ESCENARIO-2-INICIO" "MARCA-ESCENARIO-2-FIN" "^COMMIT$" "el COMMIT final es REAL (con SAVEPOINT, no hay nada abortado que ocultar)"
check_between "MARCA-ESCENARIO-2-VERIFICACION-INICIO" "MARCA-ESCENARIO-2-VERIFICACION-FIN" "^\s*2\s*$" "ambas filas (la de antes del error Y la del camino de respaldo) persistieron -- 2 filas"

echo ""
echo "=== verificando escenario 3 (citas.appointments -- 23514 contra el CHECK viejo) ==="
check_between "MARCA-ESCENARIO-3A-INICIO" "MARCA-ESCENARIO-3A-FIN" "ERROR:.*appointments_google_sync_status_check" "SIN SAVEPOINT: el UPDATE directo a 'invalid' falla 23514 contra el CHECK viejo (exactamente el código de ANTES de este PR)"
check_between "MARCA-ESCENARIO-3B-INICIO" "MARCA-ESCENARIO-3B-FIN" "ERROR:.*appointments_google_sync_status_check" "CON SAVEPOINT: el intento a 'invalid' SIGUE fallando 23514 (mismo CHECK viejo)..."
check_between "MARCA-ESCENARIO-3B-INICIO" "MARCA-ESCENARIO-3B-FIN" "^UPDATE 1$" "...pero el camino de respaldo (degradar a 'error') SÍ corre y afecta la fila"
check_between "MARCA-ESCENARIO-3B-INICIO" "MARCA-ESCENARIO-3B-FIN" "^COMMIT$" "...y el COMMIT final es REAL -- exactamente lo que markAppointmentGoogleSyncInvalid hace ahora"
check_between "MARCA-ESCENARIO-3B-VERIFICACION-INICIO" "MARCA-ESCENARIO-3B-VERIFICACION-FIN" "error.*Cal\.com rechazó" "la fila quedó en google_sync_status='error' con el motivo conservado en google_sync_error -- degradación exitosa, sin perder el intento"

echo ""
if [ "$fail" -ne 0 ]; then
  echo "=== verify-fallback-savepoint: GATE FALLIDO -- ver [FAIL] arriba (salida completa en $OUT antes de que cleanup la borre) ==="
  cat "$OUT" >&2
  exit 1
fi
echo "=== verify-fallback-savepoint: TODOS los escenarios OK ==="
