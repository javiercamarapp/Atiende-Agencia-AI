#!/usr/bin/env bash
# Postgres EFIMERO para la medicion (derivado de r18-ejec/qa/pg-up.sh): puerto 55491, SSL autofirmado (el motor de
# produccion lo exige), bootstrap + TODAS las migraciones de supabase/migrations + post-migrations.
# Uso: pg-up.sh <dir-arnes-copiado> <raiz-del-repo> <dir-datos>   (no escribe fuera de esos directorios ni de /tmp)
set -euo pipefail
QA="$1"; REPO="$2"; PGDIR="$3"; PORT=55491
# Binarios: ubuntu-latest trae PostgreSQL en /usr/lib/postgresql/<v>/bin (sin ponerlo en PATH). Si faltan, se instalan.
if ! command -v initdb >/dev/null 2>&1; then
  B="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [ -z "$B" ]; then sudo apt-get update -qq && sudo apt-get install -y -qq postgresql postgresql-contrib >/dev/null; B="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"; fi
  export PATH="$B:$PATH"
fi
command -v psql >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client >/dev/null; }
pg_ctl -D "$PGDIR" -m fast stop >/dev/null 2>&1 || true
rm -rf "$PGDIR"; initdb -D "$PGDIR" -U postgres --no-locale --encoding=UTF8 >/dev/null
openssl req -new -x509 -days 2 -nodes -text -out "$PGDIR/server.crt" -keyout "$PGDIR/server.key" -subj "/CN=localhost" >/dev/null 2>&1
chmod 600 "$PGDIR/server.key"
echo "ssl=on" >> "$PGDIR/postgresql.conf"; echo "max_connections=60" >> "$PGDIR/postgresql.conf"
pg_ctl -D "$PGDIR" -l "$PGDIR/../pg.log" -o "-p $PORT -k /tmp" -w start >/dev/null
P=(psql -h localhost -p $PORT -U postgres -v ON_ERROR_STOP=1 -q)
"${P[@]}" -d postgres -c "create database pmreal;" >/dev/null
D=("${P[@]}" -d pmreal)
"${D[@]}" -f "$QA/bootstrap.sql" >/dev/null
for f in "$REPO"/supabase/migrations/*.sql; do "${D[@]}" -f "$f" >/dev/null 2>>"$PGDIR/../migraciones.err" || { echo "FALLA $f"; exit 1; }; done
"${D[@]}" -f "$QA/post-migrations.sql" >/dev/null
echo "OK postgres://postgres@localhost:$PORT/pmreal"
