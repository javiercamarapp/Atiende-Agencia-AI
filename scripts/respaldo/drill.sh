#!/usr/bin/env bash
# drill.sh — DRILL de restauración: restaura un respaldo en un Postgres LOCAL EFÍMERO
# (initdb + socket unix, sin puertos TCP), verifica integridad y emite un reporte pass/fail
# con RPO y RTO medidos.
#
# Modos (uno solo):
#   drill.sh --latest [DIR]      el respaldo más reciente de DIR (default BACKUP_DEST o ./respaldos)
#   drill.sh --backup <dir>      un respaldo concreto
#   drill.sh --synthetic         crea una base semilla efímera con TODAS las migraciones de
#                                supabase/migrations/, datos ficticios, la respalda con
#                                backup.sh y restaura ese respaldo. Es lo que corre el CI.
#                                NO usa ninguna credencial ni base real.
#
# Qué verifica (ver lib.mjs::compareCatalogs): checksums del respaldo, restauración sin errores,
# conteos por tabla IDÉNTICOS al origen (misma foto del dump), RLS activo/forzado y número de
# políticas, GRANTs (tabla/columna/función), funciones (existencia, security definer,
# search_path fijo, EXECUTE a PUBLIC) y los invariantes del repo: security definer sin
# search_path, policies using (true), privilegios de escritura de tabla a anon (SELECT en catálogos públicos es por diseño).
#
# Variables: DRILL_REPORT_DIR (default ./drill-report-<UTC>), RPO_TARGET_SECONDS (86400),
# RTO_TARGET_SECONDS (7200), DRILL_STRICT_INVARIANTS=1 (violaciones preexistentes = FAIL; el modo
# sintético lo activa), DRILL_KEEP_BACKUP_DIR (conserva ahí una copia del respaldo sintético, para pruebas),
# RESTORE_AGE_IDENTITY si el respaldo está cifrado con age.
# Salida: 0 = PASS, 2 = FAIL (checks o RPO/RTO), 1 = error operativo del propio drill.
set -uo pipefail
# shellcheck source=scripts/respaldo/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
umask 077
trap cleanup_servers EXIT

MODE=""; BACKUP_ARG=""
case "${1:-}" in
  --latest) MODE=latest; BACKUP_ARG="${2:-${BACKUP_DEST:-./respaldos}}";;
  --backup) MODE=backup; BACKUP_ARG="${2:-}";;
  --synthetic) MODE=synthetic;;
  *) die "uso: drill.sh --latest [dir] | --backup <dir> | --synthetic";;
esac
ensure_pg_bin
need_bins node psql pg_dump pg_restore

REPORT_DIR="${DRILL_REPORT_DIR:-./drill-report-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$REPORT_DIR"
SYNTHETIC=0; STRICT="${DRILL_STRICT_INVARIANTS:-0}"
DRILL_START_MS="$(now_ms)"

if [ "$MODE" = synthetic ]; then
  SYNTHETIC=1; STRICT=1
  log "sintético: levantando base de origen efímera y aplicando supabase/migrations/"
  start_ephemeral_pg; SRC_DIR="$EPH_DIR"; SRC_PORT="$EPH_PORT"
  export PGOPTIONS="-c client_min_messages=error"
  SRC_PSQL=(psql -X -q -h "$SRC_DIR" -p "$SRC_PORT" -U postgres -v ON_ERROR_STOP=1)
  "${SRC_PSQL[@]}" -d postgres -c "create database atiende_origen" >/dev/null
  SRC_PSQL+=(-d atiende_origen)
  "${SRC_PSQL[@]}" -f "$RESPALDO_DIR/platform-bootstrap.sql" >/dev/null 2> >(redact >&2) || die "bootstrap del origen falló"
  n=0
  for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
    "${SRC_PSQL[@]}" -f "$f" >/dev/null 2> >(redact >&2) || die "falló la migración $(basename "$f")"
    n=$((n + 1))
  done
  # Lo que en Supabase real hace la plataforma (mismo GRANT que scripts/verify-fallback-savepoint/pg-post-migrations.sql).
  "${SRC_PSQL[@]}" -c "grant usage on schema citas, core to authenticated, anon" >/dev/null
  "${SRC_PSQL[@]}" -f "$RESPALDO_DIR/seed-sintetico.sql" >/dev/null 2> >(redact >&2) || die "falló el seed sintético"
  log "origen listo: $n migraciones + semilla"
  BACKUP_DEST_SYN="$(mktemp -d "${DRILL_TMPDIR:-/tmp}/atiende-bk.XXXXXX")"
  SERVER_DIRS+=("$BACKUP_DEST_SYN")
  BACKUP_DIR="$(
    BACKUP_DATABASE_URL="postgresql:///atiende_origen?host=$SRC_DIR&port=$SRC_PORT&user=postgres" \
    BACKUP_DEST="$BACKUP_DEST_SYN" BACKUP_SYNTHETIC=1 BACKUP_ENCRYPT="${DRILL_SYNTHETIC_ENCRYPT:-none}" \
    "$RESPALDO_DIR/backup.sh" | tail -1
  )" || die "backup.sh falló sobre la base sintética"
  if [ -n "${DRILL_KEEP_BACKUP_DIR:-}" ]; then mkdir -p "$DRILL_KEEP_BACKUP_DIR" && cp -R "$BACKUP_DIR" "$DRILL_KEEP_BACKUP_DIR/"; fi
  # Se apaga el origen: el drill restaura SOLO desde el respaldo, en una base distinta.
  pg_ctl -D "$SRC_DIR/data" -m fast stop >/dev/null 2>&1
  # El reloj del drill arranca aquí: el RTO mide recuperar, no fabricar la semilla.
  DRILL_START_MS="$(now_ms)"
elif [ "$MODE" = latest ]; then
  [ -d "$BACKUP_ARG" ] || die "no existe la carpeta de respaldos: $BACKUP_ARG"
  LAST="$(ls -1 "$BACKUP_ARG" | grep -E '^atiende-[0-9]{8}T[0-9]{6}Z$' | sort | tail -1)"
  [ -n "$LAST" ] || die "no hay respaldos atiende-* en $BACKUP_ARG"
  BACKUP_DIR="$BACKUP_ARG/$LAST"
else
  BACKUP_DIR="$BACKUP_ARG"
fi
[ -f "$BACKUP_DIR/manifest.json" ] || die "falta manifest.json en $BACKUP_DIR"
log "respaldo bajo prueba: $(basename "$BACKUP_DIR")"

PRE=()   # checks previos, en JSON
add_pre() { PRE+=("{\"name\":\"$1\",\"status\":\"$2\",\"detail\":\"$3\"}"); }
pre_json() { local IFS=,; printf '[%s]' "${PRE[*]:-}"; }

if cli verify-manifest "$BACKUP_DIR" >/dev/null 2>"$REPORT_DIR/manifest.err"; then
  add_pre checksums_del_respaldo pass "sha256 de cada archivo coincide con manifest.json"
else
  add_pre checksums_del_respaldo fail "$(tr -d '"\n' <"$REPORT_DIR/manifest.err" | head -c 300)"
fi

SYN_FLAG="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).synthetic?"1":"0")' "$BACKUP_DIR/manifest.json")"
[ "$SYN_FLAG" = 1 ] && SYNTHETIC=1

RESTORED_CATALOG="-"; RESTORE_SECS=0
if [ "$(printf '%s' "${PRE[0]}" | grep -c '"fail"')" -eq 0 ]; then
  log "levantando Postgres efímero de destino"
  start_ephemeral_pg; DST_DIR="$EPH_DIR"; DST_PORT="$EPH_PORT"
  DST_URL="postgresql:///atiende_restaurada?host=$DST_DIR&port=$DST_PORT&user=postgres"
  psql -X -q -h "$DST_DIR" -p "$DST_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -c "create database atiende_restaurada" >/dev/null
  if RESTORE_DATABASE_URL="$DST_URL" RESTORE_BOOTSTRAP=1 RESTORE_TIMING_FILE="$REPORT_DIR/restore-seconds" \
       "$RESPALDO_DIR/restore.sh" "$BACKUP_DIR" 2> >(redact >&2); then
    add_pre restauracion_sin_errores pass "pg_restore -1 --exit-on-error terminó sin errores"
    RESTORE_SECS="$(cat "$REPORT_DIR/restore-seconds" 2>/dev/null || echo 0)"
    SCHEMAS="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).schemas.join(","))' "$BACKUP_DIR/manifest.json")"
    printf '\\set schemas %s\n\\pset format unaligned\n\\pset tuples_only on\n\\i %s\n' "'$SCHEMAS'" "$RESPALDO_DIR/catalog-snapshot.sql" >"$REPORT_DIR/.cat.sql"
    psql -X -q -h "$DST_DIR" -p "$DST_PORT" -U postgres -d atiende_restaurada -v ON_ERROR_STOP=1 -f "$REPORT_DIR/.cat.sql" >"$REPORT_DIR/catalog-restaurado.json" 2> >(redact >&2) \
      && RESTORED_CATALOG="$REPORT_DIR/catalog-restaurado.json"
    rm -f "$REPORT_DIR/.cat.sql"
    [ "$RESTORED_CATALOG" != "-" ] || add_pre catalogo_restaurado fail "no se pudo leer el catálogo de la base restaurada"
  else
    add_pre restauracion_sin_errores fail "restore.sh falló (ver mensajes arriba)"
  fi
else
  add_pre restauracion_sin_errores fail "no se intentó: el respaldo no pasó la verificación de checksums"
fi
DRILL_END_MS="$(now_ms)"

CREATED_AT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).created_at)' "$BACKUP_DIR/manifest.json")"
EXTRA="$(node -e '
  const [pre, startMs, endMs, restoreSecs, rpoT, rtoT, synthetic, strict, name, createdAt, schemas] = process.argv.slice(1);
  console.log(JSON.stringify({
    preChecks: JSON.parse(pre), strictInvariants: strict === "1",
    timing: { backupCreatedAtMs: Date.parse(createdAt), drillStartMs: Number(startMs), drillEndMs: Number(endMs),
      restoreSeconds: Number(restoreSecs), rpoTargetSeconds: Number(rpoT), rtoTargetSeconds: Number(rtoT), synthetic: synthetic === "1" },
    meta: { synthetic: synthetic === "1", backup_name: name, backup_created_at: createdAt, schemas: schemas.split(",") } }));' \
  "$(pre_json)" "$DRILL_START_MS" "$DRILL_END_MS" "$RESTORE_SECS" "${RPO_TARGET_SECONDS:-86400}" "${RTO_TARGET_SECONDS:-7200}" \
  "$SYNTHETIC" "$STRICT" "$(basename "$BACKUP_DIR")" "$CREATED_AT" \
  "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).schemas.join(","))' "$BACKUP_DIR/manifest.json")")"

cli report "$REPORT_DIR" "$BACKUP_DIR" "$RESTORED_CATALOG" "$EXTRA"
rc=$?
log "reporte: $REPORT_DIR/report.md y report.json (veredicto: $([ $rc -eq 0 ] && echo PASS || echo FAIL))"
exit $rc
