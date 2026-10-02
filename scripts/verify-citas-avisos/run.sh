#!/usr/bin/env bash
# Verificación contra Postgres LOCAL real de C-16 (centro de avisos de citas, migración 029):
# `citas.set_escalation_follow_up` (seguimiento de escalaciones de crisis, owner/admin),
# `citas.system_avisos_resumen` (conteos de SOLO sistema para el productor de notificaciones),
# el cierre de UPDATE directo sobre `citas.emergency_escalations` y la integración con
# `core.emit_notification` (catálogo vs CHECK/destinatarios reales). Ver assertions.sql para los
# escenarios positivos, negativos (staff, otro tenant, sistema, anon), SQLSTATE exacto y tope de nota.
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente, p. ej.
# `brew install postgresql@17`). Levanta un cluster Postgres efímero en un
# directorio temporal, aplica todas las migraciones reales de
# `supabase/migrations/` en orden, corre los escenarios de `assertions.sql`, y
# apaga/borra el cluster al salir — no toca ningún Postgres existente ni dato
# real.
#
# Uso:  scripts/verify-citas-avisos/run.sh
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-citas-avisos: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
# Puerto aleatorio (no fijo) -- varios verify-*/ pueden correr en paralelo en la
# misma máquina (otros constructores, ver AGENTS.md de esta tarea); un puerto
# fijo colisiona con cualquier otro cluster efímero ya escuchando.
PGPORT=$(( (RANDOM % 20000) + 40000 ))
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

"${PSQL[@]}" -d postgres -c "create database atiende_verify;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

echo "==> aplicando las migraciones reales de supabase/migrations/ en orden"
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

echo ""
echo "==> listo — revisa arriba: los *_deberia_ser_0/1 y los bloques 'do \$\$ ... exception when sqlstate' son la prueba real del seguimiento, de la función de solo-sistema, de los controles negativos (staff/otro tenant/sistema/anon) y de la integración con el productor de notificaciones."
