#!/usr/bin/env bash
# common.sh — utilidades compartidas por backup.sh / restore.sh / drill.sh (se hace `source`).
# Regla de oro: NUNCA imprimir una URL de conexión, contraseña ni llave. Todo lo que
# se muestra pasa por `redact` y las URLs solo viajan por variables de entorno.

RESPALDO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$RESPALDO_DIR/../.." && pwd)"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { printf 'respaldo: ERROR: %s\n' "$*" >&2; exit 1; }

# Filtro de stderr/stdout de herramientas externas: oculta credenciales de URLs.
redact() { sed -E 's#(postgres(ql)?://)[^/@ ]*@#\1***@#g; s#(PGPASSWORD=)[^ ]+#\1***#g; s#(password=)[^ &]+#\1***#gI'; }

cli() { node "$RESPALDO_DIR/cli.mjs" "$@"; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# Pone en PATH los binarios de Postgres (initdb/pg_ctl/pg_dump/pg_restore/psql) si no están.
ensure_pg_bin() {
  if command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then return 0; fi
  local d
  for d in /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@*/bin /usr/local/opt/postgresql@*/bin; do
    [ -x "$d/initdb" ] && PATH="$d:$PATH" && export PATH
  done
  command -v initdb >/dev/null 2>&1 || die "no encuentro initdb/pg_ctl: instala PostgreSQL (brew install postgresql@17 | apt-get install postgresql)"
}

need_bins() { local b; for b in "$@"; do command -v "$b" >/dev/null 2>&1 || die "falta '$b' en PATH"; done; }

# Conexión de ORIGEN o DESTINO: una URL (en una variable de entorno) o las PG* estándar.
# $1 = nombre de la variable con la URL. La URL se descompone en PGHOST/PGPORT/PGUSER/
# PGPASSWORD/PGDATABASE (por stdin, nunca por argv) para que ninguna herramienta la reciba.
use_conn() {
  local var="$1" url="${!1:-}"
  if [ -n "$url" ]; then
    local assigns
    assigns="$(printf '%s' "$url" | cli conn-env)" || exit 1
    eval "$assigns"
  elif [ -z "${PGHOST:-}" ]; then die "define $var (URL de conexión) o las variables PGHOST/PGDATABASE estándar"
  fi
}

SERVER_DIRS=()
cleanup_servers() {
  local d
  for d in "${SERVER_DIRS[@]:-}"; do
    [ -n "$d" ] || continue
    pg_ctl -D "$d/data" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$d"
  done
}

# start_ephemeral_pg <varname-dir> <dbname>: initdb + arranque SOLO por socket unix
# (listen_addresses vacío: no abre ningún puerto TCP). Exporta PGHOST/PGPORT/PGUSER.
start_ephemeral_pg() {
  local base
  base="$(mktemp -d "${DRILL_TMPDIR:-/tmp}/atiende-drill.XXXXXX")"
  SERVER_DIRS+=("$base")
  chmod 700 "$base"
  initdb -D "$base/data" -U postgres --auth=trust --no-locale -E UTF8 >/dev/null || die "initdb falló"
  local port=$((55000 + RANDOM % 5000))
  pg_ctl -D "$base/data" -l "$base/postgres.log" -w -o "-p $port -k $base -c listen_addresses=''" start >/dev/null \
    || { tail -5 "$base/postgres.log" >&2; die "no arrancó Postgres efímero"; }
  EPH_DIR="$base"; EPH_PORT="$port"
}
