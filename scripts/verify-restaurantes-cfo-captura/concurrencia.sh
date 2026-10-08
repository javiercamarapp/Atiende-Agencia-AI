#!/usr/bin/env bash
# Prueba de CARRERA de sr_importar (dos conexiones reales en paralelo) contra un Postgres LOCAL efimero (initdb/pg_ctl).
# NO la descubre el gate de CI (solo ve carpetas con assertions.sql de un solo hilo); correr a mano:
#   scripts/verify-restaurantes-cfo-captura/concurrencia.sh
# Escenarios: (1) dos ARCHIVOS DISTINTOS de cuentas sobre la misma sucursal y los mismos dias; (2) resumen_servicio + cuentas de la
# misma semana en paralelo. Esperado: ninguna sesion falla y queda UN solo lote vigente por dia y sucursal.
set -euo pipefail
for bin in initdb pg_ctl psql; do command -v "$bin" >/dev/null || { echo "falta $bin" >&2; exit 1; }; done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORKDIR="$(mktemp -d /tmp/cfo83c.XXXXXX)"; PGPORT=55684; PGDATA="$WORKDIR/pgdata"
trap 'pg_ctl -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true; rm -rf "$WORKDIR"' EXIT
initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$PGDATA" -l "$WORKDIR/log" -o "-p $PGPORT -k $WORKDIR" start >/dev/null
P=(psql -h "$WORKDIR" -p "$PGPORT" -U postgres -q -v ON_ERROR_STOP=1)
"${P[@]}" -d postgres -c "create database v" >/dev/null
"${P[@]}" -d v -f "$HERE/bootstrap.sql" >/dev/null 2>&1
for f in "$REPO_ROOT"/supabase/migrations/*.sql; do "${P[@]}" -d v -f "$f" >/dev/null 2>&1; done
"${P[@]}" -d v -f "$HERE/post-migrations.sql" >/dev/null
# Fixtures (organizaciones, usuarios, helpers) = la parte previa al primer escenario de assertions.sql.
python3 - "$HERE/assertions.sql" "$WORKDIR/fix.sql" <<'PY'
import sys
s=open(sys.argv[1]).read(); open(sys.argv[2],'w').write(s[:s.index("\\echo '=== C1.")].replace('\\set ON_ERROR_STOP off',''))
PY
"${P[@]}" -d v -f "$WORKDIR/fix.sql" >/dev/null
"${P[@]}" -d v >/dev/null <<'SQL'
create or replace function public.c_cuentas(p_pref text, p_n int) returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('folio', p_pref || g::text, 'dia_negocio', (date '2026-05-01' + (g % 5))::text,
         'tipo_servicio', 'comedor', 'total_centavos', 1000, 'forma_pago', 'efectivo')) from generate_series(1, p_n) g $f$;
create or replace function public.c_resumen() returns jsonb language sql as $f$
  select jsonb_agg(jsonb_build_object('dia_negocio', (date '2026-05-01' + g)::text, 'tipo_servicio', 'comedor', 'tickets', 400,
         'bruta_centavos', 400000, 'neta_centavos', 400000)) from generate_series(0, 4) g $f$;
SQL
OA=00000000-0000-0000-0000-0000000e8301; A1=00000000-0000-0000-0000-0000000e83a1; OWN=00000000-0000-0000-0000-0000000e8311
sesion() { # $1 huella-char $2 tipo $3 expr-json
  "${P[@]}" -d v -t -A <<SQL
begin; set local role authenticated; select set_config('request.jwt.claim.sub','$OWN',true);
select 'ok:' || aceptados from restaurantes.sr_importar('$OA','$A1',repeat('$1',64),'$2','f.csv',$3);
select pg_sleep(1.5); commit;
SQL
}
fallos=0
check() { # $1 etiqueta ; consulta SQL que devuelve el numero de dias con mas de un lote vigente
  local n; n=$("${P[@]}" -d v -t -A -c "$2"); if [ "$n" = "0" ]; then echo "OK   $1"; else echo "FALLA $1 ($n)"; fallos=$((fallos+1)); fi
}
echo "== 1. dos archivos DISTINTOS de cuentas, misma sucursal y mismos dias"
sesion a cuentas "public.c_cuentas('E-',2000)" >"$WORKDIR/o1" 2>&1 & p1=$!
sesion b cuentas "public.c_cuentas('G-',2000)" >"$WORKDIR/o2" 2>&1 & p2=$!
wait $p1 || fallos=$((fallos+1)); wait $p2 || fallos=$((fallos+1)); cat "$WORKDIR/o1" "$WORKDIR/o2" | grep -c '^ok:' | sed 's/^/sesiones OK: /'
check "un solo lote vigente de cuentas por dia" "select count(*) from (select dia_negocio from restaurantes.sr_ticket where estado='vigente' group by 1 having count(distinct lote_id) > 1) x"
check "un solo lote vigente de resumen por dia" "select count(*) from (select dia_negocio from restaurantes.sr_resumen_dia where estado='vigente' group by 1 having count(distinct lote_id) > 1) x"
check "resumen == cuentas vigentes" "select (select coalesce(sum(tickets),0) from restaurantes.sr_resumen_dia where estado='vigente') - (select count(*) from restaurantes.sr_ticket where estado='vigente' and not cancelado)"
"${P[@]}" -d v -c "truncate restaurantes.sr_ticket, restaurantes.sr_resumen_dia, restaurantes.sr_import_lote" 2>/dev/null || "${P[@]}" -U postgres -d v -c "alter table restaurantes.sr_ticket disable trigger user; alter table restaurantes.sr_resumen_dia disable trigger user; alter table restaurantes.sr_import_lote disable trigger user; delete from restaurantes.sr_ticket; delete from restaurantes.sr_resumen_dia; delete from restaurantes.sr_import_lote; alter table restaurantes.sr_ticket enable trigger user; alter table restaurantes.sr_resumen_dia enable trigger user; alter table restaurantes.sr_import_lote enable trigger user;"
echo "== 2. resumen_servicio + cuentas de la misma semana en paralelo"
sesion c resumen_servicio "public.c_resumen()" >"$WORKDIR/o3" 2>&1 & p1=$!
sesion d cuentas "public.c_cuentas('H-',2000)" >"$WORKDIR/o4" 2>&1 & p2=$!
wait $p1 || fallos=$((fallos+1)); wait $p2 || fallos=$((fallos+1)); cat "$WORKDIR/o3" "$WORKDIR/o4" | grep -c '^ok:' | sed 's/^/sesiones OK: /'
check "un solo lote vigente de resumen por dia" "select count(*) from (select dia_negocio from restaurantes.sr_resumen_dia where estado='vigente' group by 1 having count(distinct lote_id) > 1) x"
check "sr_resumen_leer == suma de la fuente vigente (un solo lote)" "select count(distinct lote_id) - 1 from restaurantes.sr_resumen_dia where estado='vigente'"
[ "$fallos" = 0 ] && echo "concurrencia: OK" || { echo "concurrencia: $fallos FALLOS" >&2; exit 1; }
