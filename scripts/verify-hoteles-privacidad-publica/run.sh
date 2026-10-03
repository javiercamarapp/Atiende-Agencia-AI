#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real -- mismo patrón que
# scripts/verify-hoteles-zona-horaria/run.sh. Ejercita la migración
# 042_hoteles_privacidad_publica_huesped.sql (H-30: aviso publico, ARCO publico verificado, exportacion y mis datos;
# 032 sigue aplicandose antes): RLS/GRANT por columna/security definer reales, positivo,
# negativo, cross-tenant, anon y sesión de sistema. El mirror en memoria de
# domain-hoteles nunca aplica RLS/GRANT/triggers.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH; si faltan falla explícito.
# Uso:  scripts/verify-hoteles-privacidad-publica/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-hoteles-privacidad-publica: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55641
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

run_pass() {
  "${PSQL[@]}" -d postgres -c "create database atiende_verify_$1;" >/dev/null
  PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify_$1)

  echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

  echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ (orden: $1)"
  if [ "$1" = "prod" ]; then
    # Secuencia de la base real: 20240101000278 ya estaba aplicada y 277 llega despues y fuera de orden, antes de las
    # migraciones posteriores a 293 (la correccion de core._arco_union vive en 294).
    FILES=()
    for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
      case "$(basename "$f")" in 20240101000277_*) continue ;; esac
      v="$(basename "$f" | cut -c1-14)"
      if [ "$v" -gt 20240101000293 ] && [ -n "${DEFERRED:-}" ]; then FILES+=("$DEFERRED"); DEFERRED=""; fi
      FILES+=("$f")
    done
    [ -n "${DEFERRED:-}" ] && FILES+=("$DEFERRED")
  else
    FILES=("$REPO_ROOT"/supabase/migrations/*.sql)
  fi
  for f in "${FILES[@]}"; do
    "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
  done

  echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

  echo "==> corriendo fixtures + escenarios de hoteles (ver assertions.sql)"
  echo ""
  "${PSQL_DB[@]}" -f "$HERE/assertions.sql"
}

DEFERRED="$(ls "$REPO_ROOT"/supabase/migrations/20240101000277_*.sql)"
run_pass nueva
DEFERRED="$(ls "$REPO_ROOT"/supabase/migrations/20240101000277_*.sql)"
run_pass prod

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"deberia_ser_N\"/\"should_fail\" deben terminar en N filas o ERROR (correcto), el resto debe devolver filas/RETURNING reales."
