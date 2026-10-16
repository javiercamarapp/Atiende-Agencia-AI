#!/usr/bin/env bash
# Prueba de carga REPRODUCIBLE del webhook de WhatsApp de restaurantes (P0 "6+ mensajes simultaneos -> HTTP 500 tras 10 s").
# Levanta un Postgres efimero con SSL (el motor de produccion exige TLS), aplica las migraciones REALES, siembra una organizacion
# minima y corre carga.ts: la API real de produccion con OpenRouter y Meta simulados (ver su cabecera). Falla si algun webhook
# no responde 200 o si se pierde/duplica un mensaje.
#
# Mismo patron initdb/pg_ctl que scripts/verify-fallback-savepoint/run.sh; sin assertions.sql a proposito (no entra al
# auto-descubrimiento de run-gate.mjs). Se invoca desde su propio job en .github/workflows/postgres-real-gate.yml.
#
# Uso:  scripts/verify-whatsapp-concurrencia/run.sh [LLM_MS]      (LLM_MS por omision 600)
set -uo pipefail

for bin in initdb pg_ctl psql openssl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "verify-whatsapp-concurrencia: falta '$bin' en PATH" >&2; exit 1; }
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d /tmp/atiende-wa-conc.XXXXXX)"
PGPORT="${VERIFY_PGPORT:-55438}"
PGDATA="$WORKDIR/pgdata"
cleanup() { pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true; rm -rf "$WORKDIR"; }
trap cleanup EXIT

initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
openssl req -new -x509 -days 2 -nodes -text -out "$PGDATA/server.crt" -keyout "$PGDATA/server.key" -subj "/CN=localhost" >/dev/null 2>&1
chmod 600 "$PGDATA/server.key"
{ echo "ssl=on"; echo "max_connections=100"; } >> "$PGDATA/postgresql.conf"
pg_ctl -D "$PGDATA" -l "$WORKDIR/postgres.log" -o "-p $PGPORT -k $WORKDIR -c listen_addresses=127.0.0.1" start >/dev/null || { cat "$WORKDIR/postgres.log" >&2; exit 1; }

PSQL=(psql -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c "create database atiende_carga;" >/dev/null
DB=("${PSQL[@]}" -d atiende_carga)
echo "==> bootstrap de plataforma + migraciones reales + USAGE de schema + semilla minima"
"${DB[@]}" -f "$REPO_ROOT/scripts/verify-restaurantes-sql/bootstrap.sql" >/dev/null
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do "${DB[@]}" -f "$f" >/dev/null 2>&1 || { echo "verify-whatsapp-concurrencia: fallo la migracion $f" >&2; exit 1; }; done
"${DB[@]}" -f "$REPO_ROOT/scripts/verify-restaurantes-sql/post-migrations.sql" >/dev/null
"${DB[@]}" -f "$HERE/seed.sql" >/dev/null

echo "==> prueba de carga (API real de produccion, OpenRouter y Meta simulados)"
cd "$REPO_ROOT"
DATABASE_URL="postgres://postgres@127.0.0.1:$PGPORT/atiende_carga" npx vite-node scripts/verify-whatsapp-concurrencia/carga.ts "${1:-600}"
