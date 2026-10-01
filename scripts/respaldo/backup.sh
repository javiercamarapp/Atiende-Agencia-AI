#!/usr/bin/env bash
# backup.sh — respaldo LÓGICO de la base Supabase (pg_dump de los esquemas de la app).
#
# SOLO LECTURA contra el origen (la sesión corre con default_transaction_read_only=on).
# Lo corre JAVIER, con su cuenta y desde su máquina; el repo/CI nunca tiene ni usa la
# URL de producción (el workflow programado usa una base SINTÉTICA: ver drill.sh).
#
# Qué produce (un directorio atiende-<UTC>/ dentro de BACKUP_DEST):
#   dump.pgdump[.age|.gpg]  pg_dump -Fc de los esquemas, UNA sola foto consistente
#   catalog.json            huella (conteos, RLS, políticas, GRANTs, funciones) tomada
#                           en la MISMA transacción/snapshot que el dump
#   manifest.json           fecha (para el RPO), esquemas, sha256 de cada archivo
#
# Variables (todas por entorno; nunca se imprimen):
#   BACKUP_DATABASE_URL   conexión directa o pooler en modo SESIÓN (puerto 5432). NO sirve el
#                         pooler en modo transacción (6543): no soporta pg_export_snapshot.
#                         Alternativa: PGHOST/PGUSER/PGDATABASE/PGPASSWORD estándar.
#   BACKUP_DEST           carpeta destino (default ./respaldos). Configurable: disco externo,
#                         carpeta sincronizada, punto de montaje de un bucket, etc.
#   BACKUP_SCHEMAS        default: core,citas,hoteles,rentas,licitaciones,despachos,restaurantes
#   BACKUP_EXTRA_SCHEMAS  se agregan a la lista (p. ej. supabase_migrations)
#   BACKUP_ENCRYPT        none (default) | age | gpg
#   BACKUP_AGE_RECIPIENT  llave PÚBLICA age (age1...) si BACKUP_ENCRYPT=age
#   BACKUP_GPG_RECIPIENT  id de la llave pública gpg si BACKUP_ENCRYPT=gpg
#   BACKUP_ALLOW_PLAINTEXT=1  necesario para respaldar sin cifrar un origen NO local: el dump
#                         trae datos personales de todos los tenants.
#   BACKUP_PRUNE=1        aplica la retención después del respaldo (default: no borra nada)
#   BACKUP_RETENTION_KEEP_LAST (7)  BACKUP_RETENTION_DAYS (30): se conserva lo que cumpla
#                         CUALQUIERA de las dos; el más reciente nunca se borra.
set -uo pipefail
# shellcheck source=scripts/respaldo/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
umask 077

need_bins psql pg_dump pg_restore node
use_conn BACKUP_DATABASE_URL

DEST="${BACKUP_DEST:-./respaldos}"
SCHEMAS="$(cli schemas "${BACKUP_SCHEMAS:-core,citas,hoteles,rentas,licitaciones,despachos,restaurantes}${BACKUP_EXTRA_SCHEMAS:+,$BACKUP_EXTRA_SCHEMAS}")" || exit 1
ENCRYPT="${BACKUP_ENCRYPT:-none}"

# --- cifrado: validar ANTES de tocar la base
case "$ENCRYPT" in
  none) ;;
  age) need_bins age; [ -n "${BACKUP_AGE_RECIPIENT:-}" ] || die "BACKUP_ENCRYPT=age requiere BACKUP_AGE_RECIPIENT (llave pública age1...)";;
  gpg) need_bins gpg; [ -n "${BACKUP_GPG_RECIPIENT:-}" ] || die "BACKUP_ENCRYPT=gpg requiere BACKUP_GPG_RECIPIENT";;
  *) die "BACKUP_ENCRYPT debe ser none, age o gpg";;
esac
if [ "$ENCRYPT" = none ] && [ "${BACKUP_ALLOW_PLAINTEXT:-0}" != 1 ]; then
  cli is-local-conn || die "origen remoto sin cifrado: configura BACKUP_ENCRYPT=age|gpg (recomendado) o BACKUP_ALLOW_PLAINTEXT=1 si el destino ya es un disco cifrado"
fi

mkdir -p "$DEST" || die "no puedo crear BACKUP_DEST"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="atiende-$TS"
WORK="$DEST/.tmp-$NAME"
mkdir "$WORK" || die "no pude crear el directorio de trabajo"
trap 'rm -rf "$WORK"' EXIT

# Solo lectura a nivel de sesión, por si el rol tuviera permisos de escritura.
export PGOPTIONS="${PGOPTIONS:-} -c default_transaction_read_only=on -c statement_timeout=0"

log "comprobando conexión y esquemas existentes"
EXISTING="$(psql -X -At -v ON_ERROR_STOP=1 -c "select nspname from pg_namespace where nspname = any(string_to_array('$SCHEMAS', ',')) order by 1" 2> >(redact >&2))" \
  || die "no pude conectar al origen (revisa BACKUP_DATABASE_URL; no se imprime por seguridad)"
[ -n "$EXISTING" ] || die "ninguno de los esquemas pedidos existe en el origen"
PRESENT="$(printf '%s\n' "$EXISTING" | paste -sd, -)"
MISSING="$(node -e '
  const have = new Set(process.argv[1].split(","));
  console.log(process.argv[2].split(",").filter((s) => !have.has(s)).join(","));' "$PRESENT" "$SCHEMAS")"
[ -z "$MISSING" ] || log "AVISO: no existen en el origen (base atrasada de migraciones, es esperable): $MISSING"

DUMP_ARGS=()
for s in ${PRESENT//,/ }; do DUMP_ARGS+=(-n "$s"); done

CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "respaldando esquemas: $PRESENT"
START_MS="$(now_ms)"
# Una sola sesión psql: exporta un snapshot, toma el catálogo con ESE snapshot y lanza
# pg_dump --snapshot con el mismo. Así dump y catálogo describen la misma foto aun con
# la base en uso (sin esto los conteos nunca cuadrarían exactos).
cat >"$WORK/session.sql" <<SQL
\set ON_ERROR_STOP on
begin isolation level repeatable read read only;
select pg_export_snapshot() as snap \gset
\setenv ATIENDE_SNAP :snap
\set schemas '$PRESENT'
\pset format unaligned
\pset tuples_only on
\o '$WORK/catalog.json'
\i '$RESPALDO_DIR/catalog-snapshot.sql'
\o
\! pg_dump -Fc --no-owner --snapshot="\$ATIENDE_SNAP" ${DUMP_ARGS[*]} -f '$WORK/dump.pgdump' && touch '$WORK/.dump-ok'
commit;
SQL
psql -X -q -v ON_ERROR_STOP=1 -f "$WORK/session.sql" 2> >(redact >&2) >/dev/null
rc=$?
rm -f "$WORK/session.sql"
{ [ "$rc" -eq 0 ] && [ -f "$WORK/.dump-ok" ]; } || die "el respaldo falló (psql rc=$rc); no se publicó nada"
rm -f "$WORK/.dump-ok"
{ [ -s "$WORK/dump.pgdump" ] && [ -s "$WORK/catalog.json" ]; } || die "dump o catálogo vacío"
pg_restore -l "$WORK/dump.pgdump" >/dev/null || die "el dump no es un archivo pg_dump válido"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WORK/catalog.json" || die "catalog.json inválido"
DUMP_SECONDS=$(( ($(now_ms) - START_MS) / 1000 ))

PLAIN_SHA="$(node --input-type=module -e "import {sha256File} from '$RESPALDO_DIR/lib.mjs'; console.log(await sha256File('$WORK/dump.pgdump'))")"
case "$ENCRYPT" in
  age) age -r "$BACKUP_AGE_RECIPIENT" -o "$WORK/dump.pgdump.age" "$WORK/dump.pgdump" 2> >(redact >&2) || die "falló el cifrado age"; rm -f "$WORK/dump.pgdump";;
  gpg) gpg --batch --yes --trust-model always -r "$BACKUP_GPG_RECIPIENT" -o "$WORK/dump.pgdump.gpg" --encrypt "$WORK/dump.pgdump" 2> >(redact >&2) || die "falló el cifrado gpg"; rm -f "$WORK/dump.pgdump";;
esac

META="$(node -e '
  const [name, createdAt, schemas, missing, enc, plainSha, secs, synthetic, pgv] = process.argv.slice(1);
  console.log(JSON.stringify({ name, created_at: createdAt, schemas: schemas.split(","),
    schemas_missing: missing ? missing.split(",") : [], encryption: enc, dump_plain_sha256: plainSha,
    dump_seconds: Number(secs), synthetic: synthetic === "1", pg_dump_version: pgv }));' \
  "$NAME" "$CREATED_AT" "$PRESENT" "$MISSING" "$ENCRYPT" "$PLAIN_SHA" "$DUMP_SECONDS" "${BACKUP_SYNTHETIC:-0}" "$(pg_dump --version)")"
cli write-manifest "$WORK" "$META" || die "no pude escribir manifest.json"

mv "$WORK" "$DEST/$NAME" || die "no pude publicar el respaldo"
trap - EXIT
log "OK: $DEST/$NAME ($(du -sh "$DEST/$NAME" | cut -f1), ${DUMP_SECONDS}s, cifrado=$ENCRYPT)"
printf '%s\n' "$DEST/$NAME"

if [ "${BACKUP_PRUNE:-0}" = 1 ]; then
  while IFS= read -r old; do
    [[ "$old" =~ ^atiende-[0-9]{8}T[0-9]{6}Z$ ]] || continue
    log "retención: borrando $old"
    rm -rf "${DEST:?}/$old"
  done < <(cli retention "$DEST" "${BACKUP_RETENTION_KEEP_LAST:-7}" "${BACKUP_RETENTION_DAYS:-30}")
fi
