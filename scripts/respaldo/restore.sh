#!/usr/bin/env bash
# restore.sh — restaura un respaldo de backup.sh en una base NUEVA y VACÍA.
#
# Uso: RESTORE_DATABASE_URL=postgresql://... scripts/respaldo/restore.sh <directorio-del-respaldo>
#      (o PGHOST/PGDATABASE estándar apuntando a la base nueva)
#
# Guardias (en este orden, todas antes de escribir nada):
#   1. El destino debe ser local (socket/localhost). Un host *.supabase.co/com se rechaza
#      SIEMPRE. Para una base NUEVA en otra máquina: RESTORE_ALLOW_NON_LOCAL=1.
#   2. Se verifica el sha256 de cada archivo contra manifest.json (respaldo íntegro).
#   3. El destino NO debe contener ninguno de los esquemas del respaldo.
# Descifrado: RESTORE_AGE_IDENTITY=<archivo de llave privada age> para age; gpg usa su llavero.
# RESTORE_BOOTSTRAP=1 aplica antes platform-bootstrap.sql (roles anon/authenticated/service_role,
# auth.uid(), extensiones): solo para bases efímeras del drill, jamás en Supabase.
# RESTORE_TIMING_FILE=<ruta> guarda ahí los segundos que tardó pg_restore.
set -uo pipefail
# shellcheck source=scripts/respaldo/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
umask 077

BDIR="${1:-}"
[ -n "$BDIR" ] && [ -f "$BDIR/manifest.json" ] || die "uso: restore.sh <directorio-de-respaldo> (falta manifest.json)"
need_bins psql pg_restore node
use_conn RESTORE_DATABASE_URL

cli check-target >/dev/null || exit 1
cli verify-manifest "$BDIR" >/dev/null || exit 1

SCHEMAS="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).schemas.join(","))' "$BDIR/manifest.json")"
cli schemas "$SCHEMAS" >/dev/null || exit 1

if [ "${RESTORE_BOOTSTRAP:-0}" = 1 ]; then
  psql -X -q -v ON_ERROR_STOP=1 -f "$RESPALDO_DIR/platform-bootstrap.sql" >/dev/null 2> >(redact >&2) || die "falló platform-bootstrap.sql"
fi

TAKEN="$(psql -X -At -v ON_ERROR_STOP=1 -c "select string_agg(nspname, ',') from pg_namespace where nspname = any(string_to_array('$SCHEMAS', ','))" 2> >(redact >&2))" \
  || die "no pude conectar al destino"
[ -z "$TAKEN" ] || die "el destino ya tiene esquemas del respaldo ($TAKEN): restaura solo en una base NUEVA y vacía"

WORK="$(mktemp -d "${DRILL_TMPDIR:-/tmp}/atiende-restore.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
DUMP=""
if   [ -f "$BDIR/dump.pgdump" ];     then DUMP="$BDIR/dump.pgdump"
elif [ -f "$BDIR/dump.pgdump.age" ]; then
  need_bins age; [ -n "${RESTORE_AGE_IDENTITY:-}" ] || die "respaldo cifrado con age: define RESTORE_AGE_IDENTITY (archivo de llave privada)"
  age -d -i "$RESTORE_AGE_IDENTITY" -o "$WORK/dump.pgdump" "$BDIR/dump.pgdump.age" 2> >(redact >&2) || die "no pude descifrar (¿llave equivocada?)"
  DUMP="$WORK/dump.pgdump"
elif [ -f "$BDIR/dump.pgdump.gpg" ]; then
  need_bins gpg
  gpg --batch --yes -o "$WORK/dump.pgdump" -d "$BDIR/dump.pgdump.gpg" 2> >(redact >&2) || die "no pude descifrar con gpg"
  DUMP="$WORK/dump.pgdump"
else die "no encuentro dump.pgdump[.age|.gpg] en $BDIR"; fi

# Tras descifrar, el sha256 del texto plano debe coincidir con el del manifest.
EXPECT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).dump_plain_sha256||"")' "$BDIR/manifest.json")"
GOT="$(node --input-type=module -e "import {sha256File} from '$RESPALDO_DIR/lib.mjs'; console.log(await sha256File(process.argv[1]))" "$DUMP")"
[ -z "$EXPECT" ] || [ "$EXPECT" = "$GOT" ] || die "el dump descifrado no coincide con el sha256 del manifest"

log "restaurando $(basename "$BDIR") (esquemas: $SCHEMAS)"
START_MS="$(now_ms)"
# -1 + --exit-on-error: o se restaura todo o no queda nada a medias.
pg_restore -d "${PGDATABASE:-postgres}" --no-owner -1 --exit-on-error "$DUMP" 2> >(redact >&2) \
  || die "pg_restore falló; la transacción se revirtió y el destino quedó sin los esquemas"
SECS=$(( ($(now_ms) - START_MS) / 1000 ))
[ -z "${RESTORE_TIMING_FILE:-}" ] || printf '%s\n' "$SECS" >"$RESTORE_TIMING_FILE"
log "OK: pg_restore tardó ${SECS}s"
