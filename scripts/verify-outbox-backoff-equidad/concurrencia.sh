#!/usr/bin/env bash
# Verificacion MANUAL (no corre en el gate de CI, que usa una conexion por escenario) de que dos
# corridas concurrentes de claim_email_outbox_batch nunca reclaman la misma fila: la sesion 1
# reclama 4 filas y mantiene su transaccion abierta; la sesion 2 reclama otras 4 distintas
# (`for update of ... skip locked`) en vez de quedarse sin nada o duplicar.
# Uso: scripts/verify-outbox-backoff-equidad/concurrencia.sh   (necesita initdb/pg_ctl/psql)
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
W=$(mktemp -d); PORT=55471
initdb -D $W/d -U postgres --no-locale --encoding=UTF8 >/dev/null 2>&1 && pg_ctl -D $W/d -l $W/log -o "-p $PORT -k $W" start >/dev/null
P() { psql -h $W -p $PORT -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
P -d postgres -c "create database c;" >/dev/null
P -d c -f scripts/verify-outbox-backoff-equidad/bootstrap.sql >/dev/null
for f in supabase/migrations/*.sql; do P -d c -f $f >/dev/null 2>$W/err || { echo "FALLO al aplicar $f"; head -3 $W/err; }; done
P -d c -f scripts/verify-outbox-backoff-equidad/post-migrations.sql >/dev/null
P -d c >/dev/null <<'EOF'
insert into core.organization (id,vertical,name,slug) values ('00000000-0000-0000-0000-0000000000a1','citas','a','a'),('00000000-0000-0000-0000-0000000000a2','citas','b','b');
insert into citas.messaging_outbox (organization_id,channel,event_type,dedupe_key,payload,created_at)
select case when i<=8 then '00000000-0000-0000-0000-0000000000a1'::uuid else '00000000-0000-0000-0000-0000000000a2'::uuid end,'email','t','k'||i,'{}', now()-interval '1 day'+i*interval '1 minute' from generate_series(1,10) i;
EOF
( P -d c -At -c "begin" -c "set local role authenticated" -c "select set_config('request.jwt.claim.sub','',true)" -c "create temp table s1 as select id from citas.claim_email_outbox_batch(4)" -c "select pg_sleep(4)" -c "select 's1 reclamo '||count(*) from s1" -c "commit" > $W/s1.out 2>&1 & )
sleep 1.5
P -d c -At -c "begin" -c "set local role authenticated" -c "select set_config('request.jwt.claim.sub','',true)" -c "create temp table s2 as select id from citas.claim_email_outbox_batch(4)" -c "select 's2 reclamo '||count(*) from s2" -c "commit" > $W/s2.out 2>&1
sleep 3.5
grep reclamo $W/s1.out $W/s2.out; cat $W/s1.out | grep -i error
P -d c -At -c "select 'filas processing='||count(*)||' (distintas='||count(distinct id)||')' from citas.messaging_outbox where status='processing'"
P -d c -At -c "select 'org '||right(organization_id::text,2)||' processing='||count(*) from citas.messaging_outbox where status='processing' group by organization_id order by 1"
pg_ctl -D $W/d -m fast stop >/dev/null; rm -rf $W
# Esperado: s1 reclamo 4, s2 reclamo 4, filas processing=8 (distintas=8).
