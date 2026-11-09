#!/usr/bin/env bash
# Verificación opt-in contra un Postgres LOCAL efímero (initdb/pg_ctl), Ola 4 (G2):
# packages/db/migrations/0100_indices_tablas_grandes.sql + su gemelo concurrente
# scripts/indices-concurrentes/0100_indices_tablas_grandes.sql.
#
#   1) Gate estándar: base con TODAS las migraciones + assertions.sql vía run-gate.mjs
#      (índices válidos y aplicables a las consultas reales).
#   2) Orden de producción: base con todas las migraciones MENOS la 0100; corre el script
#      concurrente con psql -f (autocommit, fuera de transacción); después la migración
#      0100 debe aplicar como no-op y dejar los índices válidos.
#   3) El script concurrente NO puede ir dentro de una transacción (psql -1 debe fallar).
#   4) Guarda de índice INVALID: si un build concurrente quedó a medias (indisvalid=false),
#      la migración 0100 aborta en vez de darlo por bueno con `if not exists`.
#
# En CI, run-gate.mjs descubre solo el paso 1 (bootstrap/post-migrations/assertions).
# Requiere initdb/pg_ctl/psql en PATH (p. ej. PATH=~/.local/pg17/bin:$PATH).
set -euo pipefail
for bin in initdb pg_ctl psql node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "verify-indices-tablas-grandes: falta '$bin' en PATH" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
MIG="20240101000900_0100_indices_tablas_grandes.sql"
CONC="$REPO_ROOT/scripts/indices-concurrentes/0100_indices_tablas_grandes.sql"
WORKDIR="$(mktemp -d)"
PGPORT=55791
PGDATA="$WORKDIR/pgdata"
cleanup() { pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true; rm -rf "$WORKDIR"; }
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$WORKDIR/pg.log" -o "-p $PGPORT -k $WORKDIR" start >/dev/null
PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -X -q -v ON_ERROR_STOP=1)

echo "==> 1) gate estándar (run-gate.mjs)"
PGHOST="$WORKDIR" PGPORT="$PGPORT" PGUSER=postgres PGPASSWORD=x node "$REPO_ROOT/scripts/verify-real-postgres-ci/run-gate.mjs" --no-template "$HERE"

echo "==> 2) orden de producción: script concurrente primero, migración después"
"${PSQL[@]}" -d postgres -c "create database orden;"
"${PSQL[@]}" -d orden -f "$HERE/bootstrap.sql" >/dev/null
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  [ "$(basename "$f")" = "$MIG" ] && continue
  "${PSQL[@]}" -d orden -f "$f" >/dev/null
done
"${PSQL[@]}" -d orden -f "$CONC"
"${PSQL[@]}" -d orden -f "$REPO_ROOT/supabase/migrations/$MIG"
VALIDOS=$("${PSQL[@]}" -d orden -t -A -c "select count(*) from pg_index x join pg_class c on c.oid = x.indexrelid where c.relname in ('messaging_outbox_email_reintento_idx','mensaje_conversacion_creado_idx','authz_audit_log_org_denegado_idx') and x.indisvalid")
[ "$VALIDOS" = "8" ] || { echo "FALLA 2: se esperaban 8 índices válidos, hay $VALIDOS" >&2; exit 1; }
LT=$("${PSQL[@]}" -d orden -t -A -c "select current_setting('lock_timeout')")
echo "    OK: 8 índices válidos tras script+migración (lock_timeout de una sesión nueva: $LT)"

echo "==> 3) el script concurrente dentro de una transacción debe fallar"
if "${PSQL[@]}" -d orden -1 -f "$CONC" >/dev/null 2>"$WORKDIR/e3"; then
  echo "FALLA 3: psql -1 aceptó create index concurrently" >&2; exit 1
fi
grep -q "cannot run inside a transaction block" "$WORKDIR/e3" && echo "    OK: $(grep -m1 -o 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block' "$WORKDIR/e3")"

echo "==> 4) índice INVALID (build concurrente interrumpido) -> la migración aborta"
"${PSQL[@]}" -d orden -c "update pg_index set indisvalid = false where indexrelid = 'rentas.mensaje_conversacion_creado_idx'::regclass;"
if "${PSQL[@]}" -d orden -f "$REPO_ROOT/supabase/migrations/$MIG" >/dev/null 2>"$WORKDIR/e4"; then
  echo "FALLA 4: la migración aceptó un índice INVALID" >&2; exit 1
fi
echo "    OK: $(grep -m1 -o 'índice inválido.*' "$WORKDIR/e4")"
echo "==> verify-indices-tablas-grandes: TODO OK"
