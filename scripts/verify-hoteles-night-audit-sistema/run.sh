#!/usr/bin/env bash
# Verificación manual, opt-in, contra un Postgres LOCAL real — mismo patrón EXACTO
# que scripts/verify-flujos-sistema-2/run.sh (ver ese archivo y su README, y sobre
# todo scripts/verify-flujos-sistema-2/README.md sección "Punto 4 (hoteles
# night-audit/no-show) -- NO arreglado, análisis", que este script cierra). Ejercita
# el fix de:
#   * packages/domain-hoteles/migrations/023_night_audit_sistema_escritura.sql
#
# Requiere `initdb`/`pg_ctl`/`psql` en PATH. Si no están disponibles, este script
# falla explícito en vez de fingir que corrió algo.
#
# Uso:
#   scripts/verify-hoteles-night-audit-sistema/run.sh
#     Corre normal — aplica TODAS las migraciones reales, incluido el fix.
#
#   HOTELES_NIGHT_AUDIT_SISTEMA_SKIP_FIX=1 scripts/verify-hoteles-night-audit-sistema/run.sh
#     Aplica TODAS las migraciones EXCEPTO la de arriba — reproduce el estado ANTES
#     del fix, para documentar (README.md) que night-audit/no-show de verdad
#     fallaban contra Postgres real. Los escenarios de aislamiento/anon/control
#     negativo/límite deliberado no dependen del fix y deben seguir pasando igual en
#     este modo — sirve como control de que el modo --skip realmente solo quita la
#     pieza relevante, nada más.
#
# Además de correr assertions.sql (escenarios 1-31), este script corre un escenario
# de CONCURRENCIA REAL (2 conexiones psql SEPARADAS, lanzadas en paralelo, nunca
# secuencial) contra `system_post_night_audit_charge` para la MISMA property+noche —
# ver la sección "Concurrencia real" más abajo — el requisito explícito de esta tarea
# ("dos instancias a la vez") no se conforma solo con el reintento secuencial que ya
# cubre el escenario 3 de assertions.sql (ese reintento SÍ prueba el mismo guard
# atómico, pero con una sola conexión).
set -euo pipefail

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "verify-hoteles-night-audit-sistema: falta '$bin' en PATH — instala Postgres localmente para correr esta verificación (opcional, no bloquea npm test)." >&2
    exit 1
  fi
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d)"
PGPORT=55463
PGDATA="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"
SKIP_FIX="${HOTELES_NIGHT_AUDIT_SISTEMA_SKIP_FIX:-0}"
SKIP_FILES=(
  "20240101000143_023_night_audit_sistema_escritura.sql"
)

cleanup() {
  pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

is_skip_file() {
  # OJO: usa `sf` (nunca `f`) como variable de este `for` -- ver el bug real
  # documentado en el comentario de cabecera de scripts/verify-flujos-sistema/run.sh
  # (un `for f in ...` DENTRO de una función de bash reasigna PERMANENTEMENTE la `$f`
  # del scope que la llamó sin `local`). `local` es obligatorio aquí.
  local base="$1"
  local sf
  for sf in "${SKIP_FILES[@]}"; do
    [[ "$base" == "$sf" ]] && return 0
  done
  return 1
}

echo "==> initdb en $PGDATA"
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null

echo "==> arrancando Postgres efímero en el puerto $PGPORT"
pg_ctl -D "$PGDATA" -l "$LOG" -o "-p $PGPORT -k $WORKDIR" start >/dev/null

PSQL=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1)

"${PSQL[@]}" -d postgres -c "create database atiende_verify_hoteles_night_audit;" >/dev/null
PSQL_DB=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -d atiende_verify_hoteles_night_audit)

echo "==> aplicando el mock mínimo de plataforma (auth.uid()/roles/schema usage)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/bootstrap.sql" >/dev/null

if [[ "$SKIP_FIX" == "1" ]]; then
  echo "==> HOTELES_NIGHT_AUDIT_SISTEMA_SKIP_FIX=1 — aplicando TODAS las migraciones EXCEPTO el fix de este PR (reproduce el estado ANTES del fix)"
else
  echo "==> aplicando TODAS las migraciones reales de supabase/migrations/ en orden"
fi
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$f")"
  if [[ "$SKIP_FIX" == "1" ]] && is_skip_file "$base"; then
    echo "    (omitida: $base)"
    continue
  fi
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "==> otorgando USAGE de schema a authenticated/anon (lo haría la plataforma Supabase, ver post-migrations.sql)"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -f "$HERE/post-migrations.sql" >/dev/null

echo "==> corriendo fixtures + escenarios 1-31 (ver assertions.sql)"
echo ""
"${PSQL_DB[@]}" -f "$HERE/assertions.sql"

if [[ "$SKIP_FIX" == "1" ]]; then
  echo ""
  echo "==> HOTELES_NIGHT_AUDIT_SISTEMA_SKIP_FIX=1 — se omite el escenario de concurrencia real (las funciones systemXxx no existen sin el fix)."
else
  echo ""
  echo "==> Concurrencia real: 2 conexiones psql SEPARADAS, lanzadas en paralelo, intentan postear el MISMO cargo de hospedaje (misma property+folio+noche) — la doble captura debe seguir siendo IMPOSIBLE con 2 instancias reales, no solo con un reintento secuencial"
  CONC_SQL="
set role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_id, out_is_new
  from hoteles.system_post_night_audit_charge(
    '76000000-0000-0000-0000-000000000001', '76000000-0000-0000-0000-0000000000a1',
    '76000000-0000-0000-0000-0000000d0a01', '76000000-0000-0000-0000-0000000e0a01',
    '2026-09-11', 1000, 190
  );
"
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -c "$CONC_SQL" >"$WORKDIR/conc1.out" 2>"$WORKDIR/conc1.err" &
  CONC_PID1=$!
  "${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -c "$CONC_SQL" >"$WORKDIR/conc2.out" 2>"$WORKDIR/conc2.err" &
  CONC_PID2=$!
  wait "$CONC_PID1"
  CONC_STATUS1=$?
  wait "$CONC_PID2"
  CONC_STATUS2=$?

  echo "    conexión 1 (status=$CONC_STATUS1):"
  sed 's/^/      /' "$WORKDIR/conc1.out"
  echo "    conexión 2 (status=$CONC_STATUS2):"
  sed 's/^/      /' "$WORKDIR/conc2.out"

  CHARGE_COUNT="$("${PSQL_DB[@]}" -t -A -c "select count(*) from hoteles.charge where folio_id = '76000000-0000-0000-0000-0000000e0a01' and stay_date = '2026-09-11' and concept = 'hospedaje';")"
  echo "    filas reales en hoteles.charge para folio+noche 2026-09-11 tras las 2 conexiones concurrentes: $CHARGE_COUNT (debe ser exactamente 1)"
  if [[ "$CHARGE_COUNT" != "1" ]]; then
    echo "    [FAIL] concurrencia real: se esperaba EXACTAMENTE 1 fila, se encontraron $CHARGE_COUNT — doble captura real bajo 2 instancias concurrentes." >&2
    exit 1
  fi
  echo "    [PASS] concurrencia real: exactamente 1 fila, sin importar cuál de las 2 conexiones ganó la carrera."
  # Limpieza del cargo insertado por este escenario (fuera de cualquier begin/rollback
  # de assertions.sql, así que sí persiste en esta base efímera) -- no afecta el
  # resultado ya impreso, solo deja la base limpia si alguien la inspecciona después
  # con --keep-db-equivalente manual.
  "${PSQL_DB[@]}" -q -c "delete from hoteles.charge where folio_id = '76000000-0000-0000-0000-0000000e0a01' and stay_date = '2026-09-11';" >/dev/null
fi

echo ""
echo "==> listo — revisa arriba: los escenarios marcados \"deberia_ser_N\"/\"should_fail\" deben terminar en N filas o ERROR (correcto), el resto debe devolver filas/RETURNING reales; el escenario de concurrencia real debe terminar en [PASS]."
