-- Verifica, contra Postgres REAL, packages/db/migrations/0100_indices_tablas_grandes.sql (Ola 4, G2):
--   I) cada índice existe, es VÁLIDO (indisvalid) y está sobre la tabla correcta;
--   P) el planificador lo puede usar para la consulta real que lo motiva (con enable_seqscan off: en una base
--      vacía el costo siempre favorece el seq scan, así que se mide si el índice es APLICABLE al predicado);
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback propio;
-- el alias deberia_ser_N exige que la ultima fila valga N; el resto debe completar sin error.
\set ON_ERROR_STOP off
\pset pager off

-- pg_temp.usa_indice: ¿el EXPLAIN de una consulta menciona el índice? Se crea dentro de cada escenario y se revierte ahí.

-- I1) citas.messaging_outbox_email_reintento_idx existe y es válido sobre citas.messaging_outbox.
begin;
select count(*) as deberia_ser_1
from pg_index x
join pg_class ci on ci.oid = x.indexrelid
join pg_class ct on ct.oid = x.indrelid
join pg_namespace n on n.oid = ct.relnamespace
where n.nspname = 'citas' and ct.relname = 'messaging_outbox' and ci.relname = 'messaging_outbox_email_reintento_idx' and x.indisvalid and x.indisready;
rollback;

-- I2) despachos.messaging_outbox_email_reintento_idx existe y es válido sobre despachos.messaging_outbox.
begin;
select count(*) as deberia_ser_1
from pg_index x
join pg_class ci on ci.oid = x.indexrelid
join pg_class ct on ct.oid = x.indrelid
join pg_namespace n on n.oid = ct.relnamespace
where n.nspname = 'despachos' and ct.relname = 'messaging_outbox' and ci.relname = 'messaging_outbox_email_reintento_idx' and x.indisvalid and x.indisready;
rollback;

-- I3) hoteles.messaging_outbox_email_reintento_idx existe y es válido sobre hoteles.messaging_outbox.
begin;
select count(*) as deberia_ser_1
from pg_index x
join pg_class ci on ci.oid = x.indexrelid
join pg_class ct on ct.oid = x.indrelid
join pg_namespace n on n.oid = ct.relnamespace
where n.nspname = 'hoteles' and ct.relname = 'messaging_outbox' and ci.relname = 'messaging_outbox_email_reintento_idx' and x.indisvalid and x.indisready;
rollback;

-- I4) licitaciones.messaging_outbox_email_reintento_idx existe y es válido sobre licitaciones.messaging_outbox.
begin;
select count(*) as deberia_ser_1
from pg_index x
join pg_class ci on ci.oid = x.indexrelid
join pg_class ct on ct.oid = x.indrelid
join pg_namespace n on n.oid = ct.relnamespace
where n.nspname = 'licitaciones' and ct.relname = 'messaging_outbox' and ci.relname = 'messaging_outbox_email_reintento_idx' and x.indisvalid and x.indisready;
rollback;

-- I5) rentas.messaging_outbox_email_reintento_idx existe y es válido sobre rentas.messaging_outbox.
begin;
select count(*) as deberia_ser_1
from pg_index x
join pg_class ci on ci.oid = x.indexrelid
join pg_class ct on ct.oid = x.indrelid
join pg_namespace n on n.oid = ct.relnamespace
where n.nspname = 'rentas' and ct.relname = 'messaging_outbox' and ci.relname = 'messaging_outbox_email_reintento_idx' and x.indisvalid and x.indisready;
rollback;

-- I6) restaurantes.messaging_outbox_email_reintento_idx existe y es válido sobre restaurantes.messaging_outbox.
begin;
select count(*) as deberia_ser_1
from pg_index x
join pg_class ci on ci.oid = x.indexrelid
join pg_class ct on ct.oid = x.indrelid
join pg_namespace n on n.oid = ct.relnamespace
where n.nspname = 'restaurantes' and ct.relname = 'messaging_outbox' and ci.relname = 'messaging_outbox_email_reintento_idx' and x.indisvalid and x.indisready;
rollback;

-- I7) rentas.mensaje_conversacion_creado_idx existe y es válido sobre rentas.mensaje.
begin;
select count(*) as deberia_ser_1
from pg_index x
join pg_class ci on ci.oid = x.indexrelid
join pg_class ct on ct.oid = x.indrelid
join pg_namespace n on n.oid = ct.relnamespace
where n.nspname = 'rentas' and ct.relname = 'mensaje' and ci.relname = 'mensaje_conversacion_creado_idx' and x.indisvalid and x.indisready;
rollback;

-- I8) core.authz_audit_log_org_denegado_idx existe y es válido sobre core.authz_audit_log.
begin;
select count(*) as deberia_ser_1
from pg_index x
join pg_class ci on ci.oid = x.indexrelid
join pg_class ct on ct.oid = x.indrelid
join pg_namespace n on n.oid = ct.relnamespace
where n.nspname = 'core' and ct.relname = 'authz_audit_log' and ci.relname = 'authz_audit_log_org_denegado_idx' and x.indisvalid and x.indisready;
rollback;

-- P9) el claim de correo de citas (status in ('pending','failed'), channel='email', next_attempt_at <= now()) puede usar el índice parcial.
begin;
set local enable_seqscan = off;
create function pg_temp.usa_indice(p_sql text, p_indice text) returns int language plpgsql as $f$
declare r record; v text := '';
begin
  for r in execute 'explain ' || p_sql loop v := v || r."QUERY PLAN" || chr(10); end loop;
  return case when position(p_indice in v) > 0 then 1 else 0 end;
end $f$;
select pg_temp.usa_indice($q$select id from citas.messaging_outbox e where e.channel = 'email' and e.status in ('pending', 'failed') and e.attempts < 5 and e.next_attempt_at <= now()$q$, 'messaging_outbox_email_reintento_idx') as deberia_ser_1;
rollback;

-- P10) el claim de correo de despachos (status in ('pending','failed'), channel='email', next_attempt_at <= now()) puede usar el índice parcial.
begin;
set local enable_seqscan = off;
create function pg_temp.usa_indice(p_sql text, p_indice text) returns int language plpgsql as $f$
declare r record; v text := '';
begin
  for r in execute 'explain ' || p_sql loop v := v || r."QUERY PLAN" || chr(10); end loop;
  return case when position(p_indice in v) > 0 then 1 else 0 end;
end $f$;
select pg_temp.usa_indice($q$select id from despachos.messaging_outbox e where e.channel = 'email' and e.status in ('pending', 'failed') and e.attempts < 5 and e.next_attempt_at <= now()$q$, 'messaging_outbox_email_reintento_idx') as deberia_ser_1;
rollback;

-- P11) el claim de correo de hoteles (status in ('pending','failed'), channel='email', next_attempt_at <= now()) puede usar el índice parcial.
begin;
set local enable_seqscan = off;
create function pg_temp.usa_indice(p_sql text, p_indice text) returns int language plpgsql as $f$
declare r record; v text := '';
begin
  for r in execute 'explain ' || p_sql loop v := v || r."QUERY PLAN" || chr(10); end loop;
  return case when position(p_indice in v) > 0 then 1 else 0 end;
end $f$;
select pg_temp.usa_indice($q$select id from hoteles.messaging_outbox e where e.channel = 'email' and e.status in ('pending', 'failed') and e.attempts < 5 and e.next_attempt_at <= now()$q$, 'messaging_outbox_email_reintento_idx') as deberia_ser_1;
rollback;

-- P12) el claim de correo de licitaciones (status in ('pending','failed'), channel='email', next_attempt_at <= now()) puede usar el índice parcial.
begin;
set local enable_seqscan = off;
create function pg_temp.usa_indice(p_sql text, p_indice text) returns int language plpgsql as $f$
declare r record; v text := '';
begin
  for r in execute 'explain ' || p_sql loop v := v || r."QUERY PLAN" || chr(10); end loop;
  return case when position(p_indice in v) > 0 then 1 else 0 end;
end $f$;
select pg_temp.usa_indice($q$select id from licitaciones.messaging_outbox e where e.channel = 'email' and e.status in ('pending', 'failed') and e.attempts < 5 and e.next_attempt_at <= now()$q$, 'messaging_outbox_email_reintento_idx') as deberia_ser_1;
rollback;

-- P13) el claim de correo de rentas (status in ('pending','failed'), channel='email', next_attempt_at <= now()) puede usar el índice parcial.
begin;
set local enable_seqscan = off;
create function pg_temp.usa_indice(p_sql text, p_indice text) returns int language plpgsql as $f$
declare r record; v text := '';
begin
  for r in execute 'explain ' || p_sql loop v := v || r."QUERY PLAN" || chr(10); end loop;
  return case when position(p_indice in v) > 0 then 1 else 0 end;
end $f$;
select pg_temp.usa_indice($q$select id from rentas.messaging_outbox e where e.channel = 'email' and e.status in ('pending', 'failed') and e.attempts < 5 and e.next_attempt_at <= now()$q$, 'messaging_outbox_email_reintento_idx') as deberia_ser_1;
rollback;

-- P14) el claim de correo de restaurantes (status in ('pending','failed'), channel='email', next_attempt_at <= now()) puede usar el índice parcial.
begin;
set local enable_seqscan = off;
create function pg_temp.usa_indice(p_sql text, p_indice text) returns int language plpgsql as $f$
declare r record; v text := '';
begin
  for r in execute 'explain ' || p_sql loop v := v || r."QUERY PLAN" || chr(10); end loop;
  return case when position(p_indice in v) > 0 then 1 else 0 end;
end $f$;
select pg_temp.usa_indice($q$select id from restaurantes.messaging_outbox e where e.channel = 'email' and e.status in ('pending', 'failed') and e.attempts < 5 and e.next_attempt_at <= now()$q$, 'messaging_outbox_email_reintento_idx') as deberia_ser_1;
rollback;

-- P15) el historial de una conversación de rentas (where conversacion_id = $1 order by creado_en) usa el índice compuesto.
begin;
set local enable_seqscan = off;
create function pg_temp.usa_indice(p_sql text, p_indice text) returns int language plpgsql as $f$
declare r record; v text := '';
begin
  for r in execute 'explain ' || p_sql loop v := v || r."QUERY PLAN" || chr(10); end loop;
  return case when position(p_indice in v) > 0 then 1 else 0 end;
end $f$;
select pg_temp.usa_indice($q$select id from rentas.mensaje where conversacion_id = '00000000-0000-0000-0000-000000000001' order by creado_en asc$q$, 'mensaje_conversacion_creado_idx') as deberia_ser_1;
rollback;

-- P16) los accesos denegados de una organización (ficha de superadmin, 0052) usan el índice parcial.
begin;
set local enable_seqscan = off;
create function pg_temp.usa_indice(p_sql text, p_indice text) returns int language plpgsql as $f$
declare r record; v text := '';
begin
  for r in execute 'explain ' || p_sql loop v := v || r."QUERY PLAN" || chr(10); end loop;
  return case when position(p_indice in v) > 0 then 1 else 0 end;
end $f$;
select pg_temp.usa_indice($q$select route from core.authz_audit_log l where l.organization_id = '00000000-0000-0000-0000-000000000001' and l.decision = 'denied' and l.occurred_at >= now() - interval '30 days' order by l.occurred_at desc$q$, 'authz_audit_log_org_denegado_idx') as deberia_ser_1;
rollback;
