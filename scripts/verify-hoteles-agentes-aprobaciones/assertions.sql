-- H-03 (P0) -- CATALOGO DE AGENTES + APROBACIONES HUMANAS + PLANTILLAS DE WHATSAPP + GUARDRAILS.
-- Verifica contra Postgres REAL (nunca el mirror en memoria de domain-hoteles, que jamas aplica
-- RLS/GRANT/triggers/CHECK) que packages/domain-hoteles/migrations/035_hoteles_agentes_aprobaciones.sql
-- cierra lo que dice cerrar. Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs
-- (CI, auto-descubierto). Mismo patron que verify-hoteles-tickets-sla: fixtures persistentes
-- (superusuario) + cada escenario en su propio begin/rollback.
--
-- Convencion: public.verify_expect_error(sql, sqlstate) EXIGE el SQLSTATE exacto (42501 = RLS/GRANT/guard,
-- 23514 = CHECK/trigger, 22023 = parametro invalido, 55000 = estado invalido/anti-replay, P0002 = no
-- encontrada, 23505 = unico). Los positivos usan alias con sufijo de valor exacto (..._deberia_ser_N) en la
-- ULTIMA sentencia del escenario. public.verify_as(sub) fija el rol authenticated con auth.uid() = sub;
-- sub vacio = SESION DE SISTEMA (cron/agente: auth.uid() is null). public.verify_su() vuelve al superusuario.
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.verify_expect_error(p_sql text, p_sqlstate text) returns void
language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception 'esperaba SQLSTATE %, obtuve % (%) en: %', p_sqlstate, v_state, v_msg, p_sql;
    end if;
    return;
  end;
  raise exception 'esperaba SQLSTATE % pero la sentencia no fallo: %', p_sqlstate, p_sql;
end;
$$;
grant execute on function public.verify_expect_error(text, text) to public;

create or replace function public.verify_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
end;
$$;
create or replace function public.verify_su() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
grant execute on function public.verify_as(text), public.verify_su() to public;

-- Atajo para proponer: property A1, agente `revenue` por defecto, reloj fijo de sistema.
create or replace function public.verify_prop(
  p_idem text, p_action text, p_pct numeric default null, p_amt bigint default null, p_rec integer default null,
  p_text text default null, p_agent text default 'revenue', p_now timestamptz default now(),
  p_prop uuid default '00000000-0000-0000-0000-0000000a1a01'
) returns hoteles.agent_approval_request language sql as $$
  select * from hoteles.propose_agent_action(p_prop, p_agent, p_action, 'Propuesta ' || p_idem, '{}'::jsonb, p_amt, p_pct, p_rec, p_text, p_idem, p_now)
$$;
grant execute on function public.verify_prop(text, text, numeric, bigint, integer, text, text, timestamptz, uuid) to public;

-- Id de una solicitud por su llave (security definer: lo ve cualquier rol aunque su RLS no la deje ver).
create or replace function public.verify_rid(p_idem text) returns uuid language sql security definer as $$
  select id from hoteles.agent_approval_request where idempotency_key = p_idem limit 1
$$;
create or replace function public.verify_tid(p_name text, p_version integer, p_lang text default 'es_MX') returns uuid language sql security definer as $$
  select id from hoteles.agent_wa_template where name = p_name and version = p_version and language = p_lang limit 1
$$;
grant execute on function public.verify_rid(text), public.verify_tid(text, integer, text) to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-ag'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-ag')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000a1a02', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 2'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a04', 'reservations-a@example.com', 'Reservations A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a05', 'housekeeping-a@example.com', 'Housekeeping A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a07', 'maintenance-a@example.com', 'Maintenance A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a09', 'accountant-a@example.com', 'Accountant A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a0a', 'gm2-a@example.com', 'GM A2', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a04', '00000000-0000-0000-0000-00000000a001', null, 'member', 'reservations'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000a0a07', '00000000-0000-0000-0000-00000000a001', null, 'member', 'maintenance'),
  ('00000000-0000-0000-0000-0000000a0a09', '00000000-0000-0000-0000-00000000a001', null, 'member', 'accountant'),
  ('00000000-0000-0000-0000-0000000a0a0a', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.property_config (property_id, organization_id, timezone) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'America/Mexico_City')
on conflict do nothing;

-- =============================================================================
-- (a) Configuracion por agente y kill switch
-- =============================================================================

\echo '=== 1. owner pausa un agente con motivo: org derivada, paused_at/paused_by por trigger ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.agent_config (property_id, agent_key, enabled, paused_reason) values ('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', false, 'Revision de costos del mes');
select count(*) as pausa_deberia_ser_1 from hoteles.agent_config
 where property_id = '00000000-0000-0000-0000-0000000a1a01' and agent_key = 'recepcion_whatsapp' and enabled = false and paused_at is not null
   and paused_by = '00000000-0000-0000-0000-0000000a0a01' and updated_by = '00000000-0000-0000-0000-0000000a0a01' and organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 2. la bitacora registra agente_pausado con el actor, sin que el cliente la escriba ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.agent_config (property_id, agent_key, enabled, paused_reason) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', false, 'Prueba de bitacora');
select count(*) as bitacora_deberia_ser_1 from hoteles.agent_event
 where subject_type = 'config' and event_type = 'agente_pausado' and actor_id = '00000000-0000-0000-0000-0000000a0a01' and organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 3. pausar sin motivo (o con motivo de menos de 5 caracteres) es rechazado (23514) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key, enabled) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', false)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key, enabled, paused_reason) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', false, 'abc')$q$, '23514');
rollback;

\echo '=== 4. frontdesk y accountant no escriben la configuracion (42501); presupuesto 0 o negativo y agente desconocido son 23514 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key, enabled) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', true)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key, enabled) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', true)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key, monthly_budget_micro_usd) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', 0)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key, monthly_budget_micro_usd) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', -5)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key) values ('00000000-0000-0000-0000-0000000a1a01', 'hackeo')$q$, '23514');
rollback;

\echo '=== 5. columnas protegidas por GRANT de columna: organization_id, paused_by, paused_at, updated_by (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$insert into hoteles.agent_config (organization_id, property_id, agent_key) values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000a1a01', 'revenue')$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key, paused_by) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', '00000000-0000-0000-0000-0000000a0a02')$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key, paused_at) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', now())$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key, updated_by) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', '00000000-0000-0000-0000-0000000a0a02')$q$, '42501');
rollback;

\echo '=== 6. otro tenant (owner B) no escribe en la property de A (42501) y anon no lee ninguna tabla ni ejecuta las funciones (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$insert into hoteles.agent_config (property_id, agent_key) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue')$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.agent_guardrail (property_id, max_discount_pct) values ('00000000-0000-0000-0000-0000000a1a01', 5)$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type) values ('00000000-0000-0000-0000-0000000a1a01', 'reembolso')$q$, '42501');
select set_config('role', 'anon', true);
select public.verify_expect_error($q$select count(*) from hoteles.agent_config$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.agent_usage_monthly$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.agent_guardrail$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.agent_action_policy$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.agent_approval_request$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.agent_wa_template$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.agent_event$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.propose_agent_action('00000000-0000-0000-0000-0000000a1a01', 'revenue', 'descuento_tarifa', 'x', '{}', null, 5, null, null, 'anon-key-1', now())$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval('00000000-0000-0000-0000-0000000a1a01', 'aprobar', 'motivo valido')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.agent_gate('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-06')$q$, '42501');
select public.verify_expect_error($q$select hoteles.record_agent_usage('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-06', 1, 1, 1, 1)$q$, '42501');
select public.verify_expect_error($q$select hoteles.expire_agent_approvals('00000000-0000-0000-0000-0000000a1a01', now())$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'revenue', 'plantilla_anon', 'es_MX', 'utility', 'hola')$q$, '42501');
select 1 as anon_ok;
rollback;

\echo '=== 7. reanudar limpia el motivo y la autoria de la pausa; reanudar y pausar de nuevo se registran ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.agent_config (property_id, agent_key, enabled, paused_reason) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', false, 'Pausa para auditoria');
select public.verify_expect_error($q$update hoteles.agent_config set paused_reason = null where property_id = '00000000-0000-0000-0000-0000000a1a01' and agent_key = 'revenue'$q$, '23514');
update hoteles.agent_config set enabled = true where property_id = '00000000-0000-0000-0000-0000000a1a01' and agent_key = 'revenue';
select count(*) as reanudado_deberia_ser_1 from hoteles.agent_config
 where property_id = '00000000-0000-0000-0000-0000000a1a01' and agent_key = 'revenue' and enabled and paused_reason is null and paused_at is null and paused_by is null;
rollback;

\echo '=== 8. gm ajusta el presupuesto; frontdesk intenta y no modifica nada (RLS filtra el UPDATE) ==='
begin;
insert into hoteles.agent_config (property_id, agent_key, monthly_budget_micro_usd) values ('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 5000000);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
update hoteles.agent_config set monthly_budget_micro_usd = 1 where property_id = '00000000-0000-0000-0000-0000000a1a01' and agent_key = 'recepcion_whatsapp';
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
update hoteles.agent_config set monthly_budget_micro_usd = 7500000 where property_id = '00000000-0000-0000-0000-0000000a1a01' and agent_key = 'recepcion_whatsapp';
select public.verify_su();
select count(*) as presupuesto_deberia_ser_1 from hoteles.agent_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and agent_key = 'recepcion_whatsapp' and monthly_budget_micro_usd = 7500000;
rollback;

\echo '=== 9. housekeeping y maintenance no ven el catalogo; frontdesk si; owner B no ve el de A ==='
begin;
insert into hoteles.agent_config (property_id, agent_key, monthly_budget_micro_usd) values ('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 5000000);
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select count(*) as sin_acceso_deberia_ser_0 from hoteles.agent_config;
rollback;

\echo '=== 9b. maintenance tampoco ve el catalogo ==='
begin;
insert into hoteles.agent_config (property_id, agent_key, monthly_budget_micro_usd) values ('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 5000000);
select public.verify_as('00000000-0000-0000-0000-0000000a0a07');
select count(*) as sin_acceso_mt_deberia_ser_0 from hoteles.agent_config;
rollback;

\echo '=== 10. frontdesk si ve el catalogo (rol de lectura) ==='
begin;
insert into hoteles.agent_config (property_id, agent_key, monthly_budget_micro_usd) values ('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 5000000);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select count(*) as frontdesk_ve_deberia_ser_1 from hoteles.agent_config;
rollback;

\echo '=== 11. owner B no ve el catalogo de A ==='
begin;
insert into hoteles.agent_config (property_id, agent_key, monthly_budget_micro_usd) values ('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 5000000);
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select count(*) as cross_tenant_deberia_ser_0 from hoteles.agent_config;
rollback;

-- =============================================================================
-- (b) Costo acumulado por agente y compuerta del agente (solo sistema)
-- =============================================================================

\echo '=== 12. el sistema acumula el costo del mes: dos llamadas suman en la misma fila ==='
begin;
select public.verify_as('');
select hoteles.record_agent_usage('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', '2026-10', 100, 50, 1200, 1);
select hoteles.record_agent_usage('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', '2026-10', 10, 5, 1800, 2);
select out_spent_micro_usd as gasto_deberia_ser_3000 from hoteles.agent_gate('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', '2026-10');
rollback;

\echo '=== 13. la compuerta refleja pausa, presupuesto y gasto; otro mes arranca en 0; sin configuracion = activo sin tope ==='
begin;
insert into hoteles.agent_config (property_id, agent_key, enabled, monthly_budget_micro_usd, paused_reason, paused_at) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', false, 2000000, 'Tope superado el mes pasado', now());
select public.verify_as('');
select hoteles.record_agent_usage('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-10', 1, 1, 400, 1);
select public.verify_su();
select count(*) as compuerta_deberia_ser_3 from (
  select 1 from hoteles.agent_gate('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-10') g where not g.out_enabled and g.out_budget_micro_usd = 2000000 and g.out_spent_micro_usd = 400 and g.out_paused_reason is not null
  union all
  select 2 from hoteles.agent_gate('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-11') g where g.out_spent_micro_usd = 0
  union all
  select 3 from hoteles.agent_gate('00000000-0000-0000-0000-0000000a1a01', 'mantenimiento', '2026-10') g where g.out_enabled and g.out_budget_micro_usd is null and g.out_spent_micro_usd = 0
) t;
rollback;

\echo '=== 14. un usuario NO puede registrar costo, leer la compuerta ni barrer expiraciones (42501); el sistema valida negativos y mes ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select hoteles.record_agent_usage('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-10', 1, 1, 1, 1)$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.agent_gate('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-10')$q$, '42501');
select public.verify_expect_error($q$select hoteles.expire_agent_approvals('00000000-0000-0000-0000-0000000a1a01', now())$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.agent_usage_monthly (property_id, agent_key, month, cost_micro_usd) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-10', 0)$q$, '42501');
select public.verify_expect_error($q$update hoteles.agent_usage_monthly set cost_micro_usd = 0$q$, '42501');
select public.verify_as('');
select public.verify_expect_error($q$select hoteles.record_agent_usage('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-10', 1, 1, -1, 1)$q$, '22023');
select public.verify_expect_error($q$select hoteles.record_agent_usage('00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-13', 1, 1, 1, 1)$q$, '23514');
select public.verify_expect_error($q$select hoteles.record_agent_usage('00000000-0000-0000-0000-0000000a1a01', 'revenue', 'octubre', 1, 1, 1, 1)$q$, '23514');
select public.verify_expect_error($q$select hoteles.record_agent_usage('00000000-0000-0000-0000-0000000a1a01', 'hackeo', '2026-10', 1, 1, 1, 1)$q$, '23514');
select public.verify_expect_error($q$select hoteles.record_agent_usage('00000000-0000-0000-0000-00000000dead', 'revenue', '2026-10', 1, 1, 1, 1)$q$, '23503');
rollback;

\echo '=== 15. el costo acumulado lo ve el staff autorizado de la property y no otro tenant ==='
begin;
insert into hoteles.agent_usage_monthly (organization_id, property_id, agent_key, month, cost_micro_usd) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-10', 777);
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select count(*) as costo_ajeno_deberia_ser_0 from hoteles.agent_usage_monthly;
rollback;

\echo '=== 16. el costo acumulado lo ve accountant ==='
begin;
insert into hoteles.agent_usage_monthly (organization_id, property_id, agent_key, month, cost_micro_usd) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'revenue', '2026-10', 777);
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select count(*) as costo_propio_deberia_ser_1 from hoteles.agent_usage_monthly;
rollback;

-- =============================================================================
-- (c) Guardrails y politicas de accion
-- =============================================================================

\echo '=== 17. owner crea guardrails: las palabras se normalizan (minusculas, sin acentos), sin vacias ni duplicadas ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.agent_guardrail (property_id, blocked_words) values ('00000000-0000-0000-0000-0000000a1a01', array[' Gratis ', 'CORTESÍA', 'gratis', '', 'noche   gratis']);
select count(*) as palabras_deberia_ser_1 from hoteles.agent_guardrail where property_id = '00000000-0000-0000-0000-0000000a1a01' and blocked_words = array['cortesia', 'gratis', 'noche gratis'] and organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 18. guardrails: rangos y roles (23514/42501); gm si escribe; frontdesk no ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$insert into hoteles.agent_guardrail (property_id, max_discount_pct) values ('00000000-0000-0000-0000-0000000a1a01', 0)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_guardrail (property_id, max_discount_pct) values ('00000000-0000-0000-0000-0000000a1a01', 100.01)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_guardrail (property_id, max_refund_cents) values ('00000000-0000-0000-0000-0000000a1a01', 0)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_guardrail (property_id, max_mass_recipients) values ('00000000-0000-0000-0000-0000000a1a01', 0)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_guardrail (property_id, send_window_start, send_window_end) values ('00000000-0000-0000-0000-0000000a1a01', '10:00', '10:00')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_guardrail (property_id, send_window_start, send_window_end) values ('00000000-0000-0000-0000-0000000a1a01', '21:00', '08:00')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_guardrail (property_id, blocked_words) values ('00000000-0000-0000-0000-0000000a1a01', array[repeat('x', 61)])$q$, '23514');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.agent_guardrail (property_id, max_discount_pct) values ('00000000-0000-0000-0000-0000000a1a01', 5)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
insert into hoteles.agent_guardrail (property_id, max_discount_pct) values ('00000000-0000-0000-0000-0000000a1a01', 12.5);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select count(*) as gm_escribio_deberia_ser_1 from hoteles.agent_guardrail where property_id = '00000000-0000-0000-0000-0000000a1a01' and max_discount_pct = 12.5;
rollback;

\echo '=== 19. politicas: gm NO habilita ejecucion automatica (42501), owner si; contenido de cara al huesped siempre humano ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_percent) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', 'auto_bajo_umbral', 10)$q$, '42501');
insert into hoteles.agent_action_policy (property_id, action_type, expires_minutes, approver_roles) values ('00000000-0000-0000-0000-0000000a1a01', 'reembolso', 60, array['gm', 'accountant']);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_amount_cents) values ('00000000-0000-0000-0000-0000000a1a01', 'respuesta_resena', 'auto_bajo_umbral', 100)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_amount_cents) values ('00000000-0000-0000-0000-0000000a1a01', 'mensaje_masivo', 'auto_bajo_umbral', 100)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type, mode) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', 'auto_bajo_umbral')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_amount_cents) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', 'auto_bajo_umbral', 100)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type, approver_roles) values ('00000000-0000-0000-0000-0000000a1a01', 'cargo_folio', array['housekeeping'])$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type, approver_roles) values ('00000000-0000-0000-0000-0000000a1a01', 'cargo_folio', array[]::text[])$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type, expires_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'cargo_folio', 4)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.agent_action_policy (property_id, action_type, expires_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'cargo_folio', 10081)$q$, '23514');
insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_percent) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', 'auto_bajo_umbral', 10);
select count(*) as politicas_deberia_ser_2 from hoteles.agent_action_policy where property_id = '00000000-0000-0000-0000-0000000a1a01' and organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 20. gm puede cambiar la vigencia de una politica automatica ya existente, no ampliar su umbral (42501) ==='
begin;
insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_percent) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', 'auto_bajo_umbral', 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$update hoteles.agent_action_policy set auto_max_percent = 50 where property_id = '00000000-0000-0000-0000-0000000a1a01' and action_type = 'descuento_tarifa'$q$, '42501');
update hoteles.agent_action_policy set expires_minutes = 60 where property_id = '00000000-0000-0000-0000-0000000a1a01' and action_type = 'descuento_tarifa';
select count(*) as vigencia_deberia_ser_1 from hoteles.agent_action_policy where property_id = '00000000-0000-0000-0000-0000000a1a01' and expires_minutes = 60 and auto_max_percent = 10;
rollback;

\echo '=== 21. gm endurece una politica automatica a siempre_humano y los umbrales se limpian ==='
begin;
insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_percent) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', 'auto_bajo_umbral', 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
update hoteles.agent_action_policy set mode = 'siempre_humano' where property_id = '00000000-0000-0000-0000-0000000a1a01' and action_type = 'descuento_tarifa';
select count(*) as endurecida_deberia_ser_1 from hoteles.agent_action_policy where property_id = '00000000-0000-0000-0000-0000000a1a01' and mode = 'siempre_humano' and auto_max_percent is null;
rollback;

\echo '=== 22. cambios de guardrail y politica quedan en la bitacora (solo owner/gm la leen) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.agent_guardrail (property_id, max_discount_pct) values ('00000000-0000-0000-0000-0000000a1a01', 20);
insert into hoteles.agent_action_policy (property_id, action_type, expires_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'reembolso', 90);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.agent_event (organization_id, property_id, subject_type, subject_id, event_type) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'config', gen_random_uuid(), 'falsa')$q$, '42501');
select public.verify_expect_error($q$select hoteles.agent_log('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'config', gen_random_uuid(), 'falsa', '{}')$q$, '42501');
select count(*) as frontdesk_sin_bitacora_deberia_ser_0 from hoteles.agent_event;
rollback;

\echo '=== 23. owner lee la bitacora de guardrail y politica ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.agent_guardrail (property_id, max_discount_pct) values ('00000000-0000-0000-0000-0000000a1a01', 20);
insert into hoteles.agent_action_policy (property_id, action_type, expires_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'reembolso', 90);
select count(*) as bitacora_deberia_ser_2 from hoteles.agent_event where subject_type in ('guardrail', 'politica') and actor_id = '00000000-0000-0000-0000-0000000a0a01';
rollback;


-- =============================================================================
-- (d) Proponer una accion: el agente propone, nunca ejecuta
-- =============================================================================

\echo '=== 24. el agente (sistema) propone un descuento: queda PENDIENTE, sin autor humano, con vigencia de 24 h ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-24-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_su();
select count(*) as pendiente_deberia_ser_1 from hoteles.agent_approval_request
 where idempotency_key = 'k-24-0001' and status = 'pendiente' and proposed_by is null and agent_key = 'revenue' and not auto_approved
   and organization_id = '00000000-0000-0000-0000-00000000a001' and expires_at = now() + interval '1440 minutes' and decided_by is null and executed_at is null;
rollback;

\echo '=== 25. propuestas de personas: frontdesk/reservations/gm/owner si; housekeeping, maintenance y accountant no (42501); siempre quedan como manual ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select * from public.verify_prop('k-25-hk01', 'descuento_tarifa', p_pct => 5)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a07');
select public.verify_expect_error($q$select * from public.verify_prop('k-25-mt01', 'descuento_tarifa', p_pct => 5)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$select * from public.verify_prop('k-25-ac01', 'descuento_tarifa', p_pct => 5)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select * from public.verify_prop('k-25-ob01', 'descuento_tarifa', p_pct => 5)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from public.verify_prop('k-25-fd01', 'descuento_tarifa', p_pct => 5, p_agent => 'revenue');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select * from public.verify_prop('k-25-rs01', 'descuento_tarifa', p_pct => 5);
select public.verify_su();
select count(*) as manuales_deberia_ser_2 from hoteles.agent_approval_request
 where idempotency_key in ('k-25-fd01', 'k-25-rs01') and agent_key = 'manual' and proposed_by in ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-0000000a0a04') and status = 'pendiente';
rollback;

\echo '=== 26. el agente no puede proponer como manual ni con un agente inexistente (22023) ==='
begin;
select public.verify_as('');
select public.verify_expect_error($q$select * from public.verify_prop('k-26-0001', 'descuento_tarifa', p_pct => 5, p_agent => 'manual')$q$, '22023');
select public.verify_expect_error($q$select * from public.verify_prop('k-26-0002', 'descuento_tarifa', p_pct => 5, p_agent => 'hackeo')$q$, '22023');
select public.verify_expect_error($q$select * from public.verify_prop('k-26-0003', 'descuento_tarifa', p_pct => 5, p_prop => '00000000-0000-0000-0000-00000000dead')$q$, '23503');
select public.verify_su();
select count(*) as nada_encolado_deberia_ser_0 from hoteles.agent_approval_request;
rollback;

\echo '=== 27. anti-duplicado: repetir la MISMA propuesta devuelve la existente; con contenido distinto es 23505 ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-27-0001', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-27-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_expect_error($q$select * from public.verify_prop('k-27-0001', 'descuento_tarifa', p_pct => 11)$q$, '23505');
select public.verify_expect_error($q$select * from public.verify_prop('k-27-0001', 'reembolso', p_amt => 100)$q$, '23505');
select public.verify_su();
select count(*) as una_sola_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-27-0001';
rollback;

\echo '=== 28. campos obligatorios por accion y rangos (23514) ==='
begin;
select public.verify_as('');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0001', 'descuento_tarifa')$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0002', 'reembolso')$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0003', 'cargo_folio')$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0004', 'mensaje_masivo', p_rec => 5)$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0005', 'mensaje_masivo', p_text => 'hola')$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0006', 'respuesta_resena')$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0007', 'descuento_tarifa', p_pct => 0)$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0008', 'descuento_tarifa', p_pct => 100.5)$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0009', 'reembolso', p_amt => 0)$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0010', 'reembolso', p_amt => -10)$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('k-28-0011', 'transferencia', p_amt => 10)$q$, '23514');
select public.verify_expect_error($q$select * from public.verify_prop('corta', 'descuento_tarifa', p_pct => 5)$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.propose_agent_action('00000000-0000-0000-0000-0000000a1a01', 'revenue', 'descuento_tarifa', '', '{}', null, 5, null, null, 'k-28-0012', now())$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.propose_agent_action('00000000-0000-0000-0000-0000000a1a01', 'revenue', 'descuento_tarifa', 'x', '[]', null, 5, null, null, 'k-28-0013', now())$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.propose_agent_action('00000000-0000-0000-0000-0000000a1a01', 'revenue', 'descuento_tarifa', 'x', jsonb_build_object('a', repeat('z', 9000)), null, 5, null, null, 'k-28-0014', now())$q$, '23514');
select public.verify_su();
select count(*) as nada_encolado_deberia_ser_0 from hoteles.agent_approval_request;
rollback;

\echo '=== 29. topes duros por defecto, en el borde exacto: 30% / $5,000.00 / 200 destinatarios pasan; un paso mas se BLOQUEA ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-29-d30-key', 'descuento_tarifa', p_pct => 30);
select * from public.verify_prop('k-29-d3001', 'descuento_tarifa', p_pct => 30.01);
select * from public.verify_prop('k-29-r500', 'reembolso', p_amt => 500000);
select * from public.verify_prop('k-29-r5001', 'reembolso', p_amt => 500001);
select * from public.verify_prop('k-29-c500', 'cargo_folio', p_amt => 500000);
select * from public.verify_prop('k-29-c5001', 'cargo_folio', p_amt => 500001);
select * from public.verify_prop('k-29-m200', 'mensaje_masivo', p_rec => 200, p_text => 'Aviso de mantenimiento programado');
select * from public.verify_prop('k-29-m201', 'mensaje_masivo', p_rec => 201, p_text => 'Aviso de mantenimiento programado');
select public.verify_su();
select count(*) as bordes_deberia_ser_8 from hoteles.agent_approval_request where
     (idempotency_key = 'k-29-d30-key' and status = 'pendiente')
  or (idempotency_key = 'k-29-d3001' and status = 'bloqueada' and block_reason = 'tope_descuento')
  or (idempotency_key = 'k-29-r500' and status = 'pendiente')
  or (idempotency_key = 'k-29-r5001' and status = 'bloqueada' and block_reason = 'tope_reembolso')
  or (idempotency_key = 'k-29-c500' and status = 'pendiente')
  or (idempotency_key = 'k-29-c5001' and status = 'bloqueada' and block_reason = 'tope_cargo_folio')
  or (idempotency_key = 'k-29-m200' and status = 'pendiente')
  or (idempotency_key = 'k-29-m201' and status = 'bloqueada' and block_reason = 'tope_destinatarios');
rollback;

\echo '=== 30. topes configurados: con max 10% el 10 pasa y el 10.01 se bloquea; el tope se endurece sin tocar lo ya propuesto ==='
begin;
insert into hoteles.agent_guardrail (property_id, max_discount_pct, max_refund_cents) values ('00000000-0000-0000-0000-0000000a1a01', 10, 1000);
select public.verify_as('');
select * from public.verify_prop('k-30-d10-key', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-30-d1001', 'descuento_tarifa', p_pct => 10.01);
select * from public.verify_prop('k-30-r1000', 'reembolso', p_amt => 1000);
select * from public.verify_prop('k-30-r1001', 'reembolso', p_amt => 1001);
select public.verify_su();
select count(*) as tope_configurado_deberia_ser_4 from hoteles.agent_approval_request where
     (idempotency_key = 'k-30-d10-key' and status = 'pendiente')
  or (idempotency_key = 'k-30-d1001' and status = 'bloqueada')
  or (idempotency_key = 'k-30-r1000' and status = 'pendiente')
  or (idempotency_key = 'k-30-r1001' and status = 'bloqueada');
rollback;

\echo '=== 31. palabras bloqueadas: palabra completa sin importar mayusculas/acentos/puntuacion; una subcadena NO bloquea ==='
begin;
insert into hoteles.agent_guardrail (property_id, blocked_words) values ('00000000-0000-0000-0000-0000000a1a01', array['gratis', 'cortesia', 'noche gratis']);
select public.verify_as('');
select * from public.verify_prop('k-31-a-key', 'respuesta_resena', p_text => 'Le ofrecemos una noche GRATIS en su proxima visita');
select * from public.verify_prop('k-31-b-key', 'respuesta_resena', p_text => 'Una Cortesía de la casa para usted');
select * from public.verify_prop('k-31-c-key', 'respuesta_resena', p_text => 'Todo es gratis.');
select * from public.verify_prop('k-31-d-key', 'respuesta_resena', p_text => 'Eso es gratisimo para nosotros');
select * from public.verify_prop('k-31-e-key', 'respuesta_resena', p_text => 'Nunca regratis ni agratis');
select * from public.verify_prop('k-31-f-key', 'respuesta_resena', p_text => 'Gracias por su comentario, lo atendemos');
select * from public.verify_prop('k-31-g-key', 'respuesta_resena', p_text => 'Una   noche    gratis');
select * from public.verify_prop('k-31-h-key', 'respuesta_resena', p_text => 'Mensaje limpio', p_agent => 'reputacion');
select public.verify_su();
select count(*) as palabras_deberia_ser_8 from hoteles.agent_approval_request where
     (idempotency_key = 'k-31-a-key' and status = 'bloqueada' and block_reason = 'palabra_bloqueada')
  or (idempotency_key = 'k-31-b-key' and status = 'bloqueada' and block_reason = 'palabra_bloqueada')
  or (idempotency_key = 'k-31-c-key' and status = 'bloqueada' and block_reason = 'palabra_bloqueada')
  or (idempotency_key = 'k-31-d-key' and status = 'pendiente')
  or (idempotency_key = 'k-31-e-key' and status = 'pendiente')
  or (idempotency_key = 'k-31-f-key' and status = 'pendiente')
  or (idempotency_key = 'k-31-g-key' and status = 'bloqueada' and block_reason = 'palabra_bloqueada')
  or (idempotency_key = 'k-31-h-key' and status = 'pendiente');
rollback;

\echo '=== 32. la palabra bloqueada tambien se detecta en el resumen y en montos de otras acciones ==='
begin;
insert into hoteles.agent_guardrail (property_id, blocked_words) values ('00000000-0000-0000-0000-0000000a1a01', array['regalo']);
select public.verify_as('');
select * from hoteles.propose_agent_action('00000000-0000-0000-0000-0000000a1a01', 'revenue', 'descuento_tarifa', 'Descuento como REGALO', '{}', null, 5, null, null, 'k-32-0001', now());
select public.verify_su();
select count(*) as resumen_bloqueado_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-32-0001' and status = 'bloqueada' and block_reason = 'palabra_bloqueada';
rollback;

\echo '=== 33. un agente PAUSADO no puede encolar acciones (bloqueada: agente_pausado); otros agentes y propuestas manuales no se afectan ==='
begin;
insert into hoteles.agent_config (property_id, agent_key, enabled, paused_reason, paused_at) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', false, 'Pausado por auditoria', now());
select public.verify_as('');
select * from public.verify_prop('k-33-a-key', 'descuento_tarifa', p_pct => 5, p_agent => 'revenue');
select * from public.verify_prop('k-33-b-key', 'respuesta_resena', p_text => 'Gracias por su visita', p_agent => 'reputacion');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from public.verify_prop('k-33-c-key', 'descuento_tarifa', p_pct => 5);
select public.verify_su();
select count(*) as pausa_deberia_ser_3 from hoteles.agent_approval_request where
     (idempotency_key = 'k-33-a-key' and status = 'bloqueada' and block_reason = 'agente_pausado')
  or (idempotency_key = 'k-33-b-key' and status = 'pendiente')
  or (idempotency_key = 'k-33-c-key' and status = 'pendiente' and agent_key = 'manual');
rollback;

\echo '=== 34. cola llena: con 200 pendientes vigentes, la siguiente se bloquea (cola_llena) en vez de crecer sin limite ==='
begin;
select public.verify_as('');
select count(*) from (select public.verify_prop('k-34-' || lpad(g::text, 4, '0'), 'descuento_tarifa', p_pct => 5) from generate_series(1, 201) g) t;
select public.verify_su();
select count(*) as cola_llena_deberia_ser_1 from hoteles.agent_approval_request where status = 'bloqueada' and block_reason = 'cola_llena' and idempotency_key = 'k-34-0201';
rollback;

\echo '=== 35. ejecucion automatica bajo umbral (politica del dueno): solo el agente, solo por debajo/igual del umbral; lo demas sigue a humano ==='
begin;
insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_percent) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', 'auto_bajo_umbral', 10);
insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_amount_cents) values ('00000000-0000-0000-0000-0000000a1a01', 'reembolso', 'auto_bajo_umbral', 10000);
select public.verify_as('');
select * from public.verify_prop('k-35-d10-key', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-35-d1001', 'descuento_tarifa', p_pct => 10.01);
select * from public.verify_prop('k-35-d31-key', 'descuento_tarifa', p_pct => 31);
select * from public.verify_prop('k-35-r10000', 'reembolso', p_amt => 10000);
select * from public.verify_prop('k-35-r10001', 'reembolso', p_amt => 10001);
select * from public.verify_prop('k-35-resena', 'respuesta_resena', p_text => 'Gracias por su comentario');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from public.verify_prop('k-35-manual', 'descuento_tarifa', p_pct => 5);
select public.verify_su();
select count(*) as auto_deberia_ser_7 from hoteles.agent_approval_request where
     (idempotency_key = 'k-35-d10-key' and status = 'aprobada' and auto_approved and decided_by is null and decision_reason = 'politica_auto_bajo_umbral' and decided_at is not null)
  or (idempotency_key = 'k-35-d1001' and status = 'pendiente' and not auto_approved)
  or (idempotency_key = 'k-35-d31-key' and status = 'bloqueada')
  or (idempotency_key = 'k-35-r10000' and status = 'aprobada' and auto_approved)
  or (idempotency_key = 'k-35-r10001' and status = 'pendiente')
  or (idempotency_key = 'k-35-resena' and status = 'pendiente')
  or (idempotency_key = 'k-35-manual' and status = 'pendiente' and not auto_approved and agent_key = 'manual');
rollback;

\echo '=== 36. la vigencia sale de la politica: 5 minutos -> expira exactamente 5 minutos despues de la propuesta ==='
begin;
insert into hoteles.agent_action_policy (property_id, action_type, expires_minutes) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', 5);
select public.verify_as('');
select * from public.verify_prop('k-36-0001', 'descuento_tarifa', p_pct => 5);
select public.verify_su();
select count(*) as vigencia_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-36-0001' and expires_at = now() + interval '5 minutes';
rollback;


-- =============================================================================
-- (e) Decidir: aprobar/rechazar con motivo, roles, maker-checker, anti-replay, expiracion
-- =============================================================================

\echo '=== 37. owner aprueba la propuesta del agente: queda aprobada con decisor, momento y motivo ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-37-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-37-0001'), 'aprobar', 'Ocupacion baja el fin de semana');
select count(*) as aprobada_deberia_ser_1 from hoteles.agent_approval_request
 where idempotency_key = 'k-37-0001' and status = 'aprobada' and decided_by = '00000000-0000-0000-0000-0000000a0a01' and decision_reason = 'Ocupacion baja el fin de semana' and decided_at is not null and not auto_approved;
rollback;

\echo '=== 38. rechazar exige motivo; gm tambien decide; el rechazo queda con su motivo ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-38-0001', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-38-0002', 'descuento_tarifa', p_pct => 12);
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-38-0001'), 'rechazar', null)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-38-0001'), 'rechazar', 'no')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-38-0001'), 'rechazar', '     ')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-38-0001'), 'quizas', 'motivo valido')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-38-0001'), 'rechazar', repeat('x', 501))$q$, '22023');
select * from hoteles.decide_agent_approval(public.verify_rid('k-38-0001'), 'rechazar', 'Rompe la paridad con Booking');
select public.verify_su();
select count(*) as rechazo_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-38-0001' and status = 'rechazada' and decided_by = '00000000-0000-0000-0000-0000000a0a02' and decision_reason = 'Rompe la paridad con Booking';
rollback;

\echo '=== 39. solo los roles de la politica deciden (owner siempre): frontdesk/housekeeping/accountant 42501 por defecto; con politica accountant, accountant si ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-39-0001', 'reembolso', p_amt => 1000);
select * from public.verify_prop('k-39-0002', 'reembolso', p_amt => 2000);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-39-0001'), 'aprobar', 'motivo valido')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-39-0001'), 'aprobar', 'motivo valido')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-39-0001'), 'aprobar', 'motivo valido')$q$, '42501');
select public.verify_su();
insert into hoteles.agent_action_policy (property_id, action_type, approver_roles) values ('00000000-0000-0000-0000-0000000a1a01', 'reembolso', array['gm', 'accountant']);
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select * from hoteles.decide_agent_approval(public.verify_rid('k-39-0001'), 'aprobar', 'Conciliado contra el cargo original');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-39-0002'), 'aprobar', 'El dueno siempre puede decidir');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-39-0001'), 'aprobar', 'ya decidida por contabilidad')$q$, '55000');
select public.verify_su();
select count(*) as decisores_deberia_ser_2 from hoteles.agent_approval_request
 where (idempotency_key = 'k-39-0001' and status = 'aprobada' and decided_by = '00000000-0000-0000-0000-0000000a0a09') or (idempotency_key = 'k-39-0002' and status = 'aprobada' and decided_by = '00000000-0000-0000-0000-0000000a0a01');
rollback;

\echo '=== 40. maker-checker: quien propone no decide su propia solicitud (42501); otra persona si ==='
begin;
insert into hoteles.agent_action_policy (property_id, action_type, approver_roles) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', array['owner', 'gm', 'frontdesk']);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from public.verify_prop('k-40-fd-key', 'descuento_tarifa', p_pct => 5);
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from public.verify_prop('k-40-gm-key', 'descuento_tarifa', p_pct => 6);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-40-fd-key'), 'aprobar', 'me la apruebo yo mismo')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-40-gm-key'), 'aprobar', 'me la apruebo yo mismo')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-40-gm-key'), 'rechazar', 'me la rechazo yo mismo')$q$, '42501');
select * from hoteles.decide_agent_approval(public.verify_rid('k-40-fd-key'), 'aprobar', 'Revisado por la gerencia');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-40-gm-key'), 'aprobar', 'Revisado por el dueno');
select public.verify_su();
select count(*) as cruzadas_deberia_ser_2 from hoteles.agent_approval_request where idempotency_key in ('k-40-fd-key', 'k-40-gm-key') and status = 'aprobada';
rollback;

\echo '=== 41. anti-replay: una solicitud ya decidida no se decide de nuevo (55000), ni aprobada->rechazada, ni rechazada->aprobada ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-41-a-key', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-41-b-key', 'descuento_tarifa', p_pct => 11);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-41-a-key'), 'aprobar', 'Primera decision valida');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-41-a-key'), 'aprobar', 'Repetir la aprobacion')$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-41-a-key'), 'rechazar', 'Cambiar de opinion despues')$q$, '55000');
select * from hoteles.decide_agent_approval(public.verify_rid('k-41-b-key'), 'rechazar', 'Primera decision valida');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-41-b-key'), 'aprobar', 'Reabrir una rechazada')$q$, '55000');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-41-b-key'), 'aprobar', 'Otro decisor tampoco puede')$q$, '55000');
select public.verify_su();
select count(*) as sin_cambios_deberia_ser_2 from hoteles.agent_approval_request where (idempotency_key = 'k-41-a-key' and status = 'aprobada' and decision_reason = 'Primera decision valida') or (idempotency_key = 'k-41-b-key' and status = 'rechazada' and decision_reason = 'Primera decision valida');
rollback;

\echo '=== 42. cross-tenant: owner B no decide, cancela ni consume una solicitud de A (P0002, igual que una inexistente) ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-42-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-42-0001'), 'aprobar', 'intento ajeno valido')$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.cancel_agent_approval(public.verify_rid('k-42-0001'), 'intento ajeno valido')$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-42-0001'), 'ref')$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval('00000000-0000-0000-0000-00000000dead', 'aprobar', 'no existe esta')$q$, 'P0002');
select public.verify_su();
select count(*) as intacta_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-42-0001' and status = 'pendiente' and decided_by is null;
rollback;

\echo '=== 43. expiracion: decidir una solicitud vencida la marca expirada (y NO la aprueba), aunque el cliente mande un reloj atrasado ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-43-0001', 'descuento_tarifa', p_pct => 10, p_now => '2020-01-01 00:00:00+00');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-43-0001'), 'aprobar', 'Intento tardio con reloj falso', '2019-01-01 00:00:00+00');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-43-0001'), 'aprobar', 'Segundo intento tardio')$q$, '55000');
select public.verify_su();
select count(*) as expirada_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-43-0001' and status = 'expirada' and decided_by is null;
rollback;

\echo '=== 44. barrido de expiracion (sistema): un segundo antes del limite no expira nada ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-44-pend', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-44-appr', 'descuento_tarifa', p_pct => 11);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-44-appr'), 'aprobar', 'Aprobada y sin ejecutar');
select public.verify_as('');
select hoteles.expire_agent_approvals('00000000-0000-0000-0000-0000000a1a01', now() + interval '1440 minutes' - interval '1 second') as antes_del_limite;
select public.verify_su();
select count(*) as nada_expirado_deberia_ser_0 from hoteles.agent_approval_request where status = 'expirada';
rollback;

\echo '=== 45. barrido de expiracion: en el instante exacto del limite expiran la pendiente y la aprobada sin ejecutar (2); la ejecutada no ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-45-pend', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-45-appr', 'descuento_tarifa', p_pct => 11);
select * from public.verify_prop('k-45-exec', 'descuento_tarifa', p_pct => 12);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-45-appr'), 'aprobar', 'Aprobada y sin ejecutar');
select * from hoteles.decide_agent_approval(public.verify_rid('k-45-exec'), 'aprobar', 'Aprobada y ejecutada luego');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-45-exec'), 'ref-45', '2026-06-01 12:40:00+00');
select hoteles.expire_agent_approvals('00000000-0000-0000-0000-0000000a1a01', now() + interval '1440 minutes') as primera;
select public.verify_su();
select count(*) as expiradas_deberia_ser_2 from hoteles.agent_approval_request where status = 'expirada' and property_id = '00000000-0000-0000-0000-0000000a1a01' and idempotency_key in ('k-45-pend', 'k-45-appr');
rollback;

\echo '=== 46. el barrido es idempotente (segunda corrida = 0) ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-46-pend', 'descuento_tarifa', p_pct => 10);
select hoteles.expire_agent_approvals('00000000-0000-0000-0000-0000000a1a01', now() + interval '30 days') as primera;
select public.verify_su();
select hoteles.expire_agent_approvals('00000000-0000-0000-0000-0000000a1a01', now() + interval '30 days') as segunda_deberia_ser_0;
rollback;

\echo '=== 47. el barrido solo toca la property pedida y la ejecutada queda ejecutada ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-47-pend', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-47-otra', 'descuento_tarifa', p_pct => 13, p_prop => '00000000-0000-0000-0000-0000000a1a02');
select hoteles.expire_agent_approvals('00000000-0000-0000-0000-0000000a1a01', now() + interval '30 days');
select public.verify_su();
select count(*) as otra_property_intacta_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-47-otra' and status = 'pendiente';
rollback;

\echo '=== 48. aprobar respeta el guardrail VIGENTE: si el tope se endurecio despues de proponer, aprobar es 23514; rechazar siempre se puede ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-48-0001', 'descuento_tarifa', p_pct => 20);
select * from public.verify_prop('k-48-0002', 'descuento_tarifa', p_pct => 21);
select public.verify_su();
insert into hoteles.agent_guardrail (property_id, max_discount_pct) values ('00000000-0000-0000-0000-0000000a1a01', 15);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select * from hoteles.decide_agent_approval(public.verify_rid('k-48-0001'), 'aprobar', 'Intento sobre el tope nuevo')$q$, '23514');
select * from hoteles.decide_agent_approval(public.verify_rid('k-48-0002'), 'rechazar', 'Excede el tope vigente');
select public.verify_su();
select count(*) as tope_vigente_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-48-0001' and status = 'pendiente';
rollback;

-- =============================================================================
-- (f) Consumir (ejecutar UNA vez)
-- =============================================================================

\echo '=== 49. el sistema consume una aprobacion: ejecutada una sola vez; el segundo intento (replay) es 55000 ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-49-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-49-0001'), 'aprobar', 'Aprobada para ejecutar');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-49-0001'), 'tarifa-123', '2026-06-01 13:00:00+00');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-49-0001'), 'tarifa-123', '2026-06-01 13:00:00+00')$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-49-0001'), 'otra-ref', '2026-06-01 13:05:00+00')$q$, '55000');
select public.verify_su();
select count(*) as una_ejecucion_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-49-0001' and status = 'ejecutada' and execution_ref = 'tarifa-123' and executed_at = '2026-06-01 13:00:00+00' and executed_by is null;
rollback;

\echo '=== 50. no se consume lo no aprobado: pendiente, rechazada, cancelada y bloqueada son 55000 ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-50-pend', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-50-rech', 'descuento_tarifa', p_pct => 11);
select * from public.verify_prop('k-50-canc', 'descuento_tarifa', p_pct => 12);
select * from public.verify_prop('k-50-bloq', 'descuento_tarifa', p_pct => 90);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-50-rech'), 'rechazar', 'No procede por ahora');
select * from hoteles.cancel_agent_approval(public.verify_rid('k-50-canc'), 'Ya no hace falta');
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-50-pend'), 'ref')$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-50-rech'), 'ref')$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-50-canc'), 'ref')$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-50-bloq'), 'ref')$q$, '55000');
select public.verify_su();
select count(*) as ninguna_ejecutada_deberia_ser_0 from hoteles.agent_approval_request where status = 'ejecutada';
rollback;

\echo '=== 51. un owner/gm puede ejecutar a mano (quedan sus datos); frontdesk no (P0002) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from public.verify_prop('k-51-0001', 'reembolso', p_amt => 1000);
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from hoteles.decide_agent_approval(public.verify_rid('k-51-0001'), 'aprobar', 'Aprobada para ejecutar a mano');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-51-0001'), 'manual-1')$q$, 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from hoteles.consume_agent_approval(public.verify_rid('k-51-0001'), 'manual-1');
select count(*) as manual_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-51-0001' and status = 'ejecutada' and executed_by = '00000000-0000-0000-0000-0000000a0a02' and execution_ref = 'manual-1';
rollback;

\echo '=== 52. consumir una aprobacion vencida la marca expirada y NO ejecuta ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-52-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-52-0001'), 'aprobar', 'Aprobada a tiempo');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-52-0001'), 'tarde', now() + interval '1441 minutes');
select public.verify_su();
select count(*) as vencida_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-52-0001' and status = 'expirada' and executed_at is null;
rollback;

\echo '=== 53. un usuario no puede rebobinar el reloj al consumir: su p_now se ignora (now() real) ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-53-0001', 'descuento_tarifa', p_pct => 10, p_now => '2020-01-01 00:00:00+00');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-53-0001'), 'aprobar', 'Intento sobre una vencida');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-53-0001'), 'ref', '2019-01-01 00:00:00+00')$q$, '55000');
select public.verify_su();
select count(*) as no_ejecutada_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-53-0001' and status = 'expirada' and executed_at is null;
rollback;

\echo '=== 54. un guardrail endurecido DESPUES de aprobar tambien frena la ejecucion: queda bloqueada con su motivo ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-54-0001', 'descuento_tarifa', p_pct => 20);
select * from public.verify_prop('k-54-0002', 'respuesta_resena', p_text => 'Le ofrecemos una cortesia de la casa');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-54-0001'), 'aprobar', 'Aprobado con el tope anterior');
select * from hoteles.decide_agent_approval(public.verify_rid('k-54-0002'), 'aprobar', 'Aprobada con la lista anterior');
insert into hoteles.agent_guardrail (property_id, max_discount_pct, blocked_words) values ('00000000-0000-0000-0000-0000000a1a01', 15, array['cortesia']);
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-54-0001'), 'ref-54a', '2026-06-01 13:00:00+00');
select * from hoteles.consume_agent_approval(public.verify_rid('k-54-0002'), 'ref-54b', '2026-06-01 13:00:00+00');
select public.verify_su();
select count(*) as bloqueadas_deberia_ser_2 from hoteles.agent_approval_request where
     (idempotency_key = 'k-54-0001' and status = 'bloqueada' and block_reason = 'tope_descuento' and executed_at is null)
  or (idempotency_key = 'k-54-0002' and status = 'bloqueada' and block_reason = 'palabra_bloqueada' and executed_at is null);
rollback;

\echo '=== 55. horario de envio de mensajes masivos (America/Mexico_City, UTC-6): 07:59 difiere, 08:00 ejecuta, 20:59 ejecuta, 21:00 difiere ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-55-0759', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso de corte de agua');
select * from public.verify_prop('k-55-0800', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso de corte de agua 2');
select * from public.verify_prop('k-55-2059', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso de corte de agua 3');
select * from public.verify_prop('k-55-2100', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso de corte de agua 4');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-55-0759'), 'aprobar', 'Aprobado para el horario');
select * from hoteles.decide_agent_approval(public.verify_rid('k-55-0800'), 'aprobar', 'Aprobado para el horario');
select * from hoteles.decide_agent_approval(public.verify_rid('k-55-2059'), 'aprobar', 'Aprobado para el horario');
select * from hoteles.decide_agent_approval(public.verify_rid('k-55-2100'), 'aprobar', 'Aprobado para el horario');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-55-0759'), 'ref', '2026-03-10 13:59:00+00');
select * from hoteles.consume_agent_approval(public.verify_rid('k-55-0800'), 'ref', '2026-03-10 14:00:00+00');
select * from hoteles.consume_agent_approval(public.verify_rid('k-55-2059'), 'ref', '2026-03-11 02:59:00+00');
select * from hoteles.consume_agent_approval(public.verify_rid('k-55-2100'), 'ref', '2026-03-11 03:00:00+00');
select public.verify_su();
select count(*) as horario_deberia_ser_4 from hoteles.agent_approval_request where
     (idempotency_key = 'k-55-0759' and status = 'aprobada')
  or (idempotency_key = 'k-55-0800' and status = 'ejecutada')
  or (idempotency_key = 'k-55-2059' and status = 'ejecutada')
  or (idempotency_key = 'k-55-2100' and status = 'aprobada');
rollback;

\echo '=== 56. una aprobacion diferida por horario se ejecuta despues, dentro de la ventana (no se pierde ni se duplica) ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-56-0001', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso de corte de agua');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-56-0001'), 'aprobar', 'Aprobado para el horario');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-56-0001'), 'ref', '2026-03-11 05:00:00+00');
select * from hoteles.consume_agent_approval(public.verify_rid('k-56-0001'), 'ref', '2026-03-10 15:00:00+00');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-56-0001'), 'ref', '2026-03-10 16:00:00+00')$q$, '55000');
select public.verify_su();
select count(*) as diferida_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-56-0001' and status = 'ejecutada' and executed_at = '2026-03-10 15:00:00+00';
rollback;

\echo '=== 57. ventana configurada por property 10:00-12:00 (inicio inclusivo, fin exclusivo) ==='
begin;
insert into hoteles.agent_guardrail (property_id, send_window_start, send_window_end) values ('00000000-0000-0000-0000-0000000a1a01', '10:00', '12:00');
select public.verify_as('');
select * from public.verify_prop('k-57-a-key', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso A');
select * from public.verify_prop('k-57-b-key', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso B');
select * from public.verify_prop('k-57-c-key', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso C');
select * from public.verify_prop('k-57-d-key', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso D');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-57-a-key'), 'aprobar', 'Aprobado para el horario');
select * from hoteles.decide_agent_approval(public.verify_rid('k-57-b-key'), 'aprobar', 'Aprobado para el horario');
select * from hoteles.decide_agent_approval(public.verify_rid('k-57-c-key'), 'aprobar', 'Aprobado para el horario');
select * from hoteles.decide_agent_approval(public.verify_rid('k-57-d-key'), 'aprobar', 'Aprobado para el horario');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-57-a-key'), 'ref', '2026-03-10 15:59:00+00');
select * from hoteles.consume_agent_approval(public.verify_rid('k-57-b-key'), 'ref', '2026-03-10 16:00:00+00');
select * from hoteles.consume_agent_approval(public.verify_rid('k-57-c-key'), 'ref', '2026-03-10 17:59:00+00');
select * from hoteles.consume_agent_approval(public.verify_rid('k-57-d-key'), 'ref', '2026-03-10 18:00:00+00');
select public.verify_su();
select count(*) as ventana_deberia_ser_4 from hoteles.agent_approval_request where
     (idempotency_key = 'k-57-a-key' and status = 'aprobada')
  or (idempotency_key = 'k-57-b-key' and status = 'ejecutada')
  or (idempotency_key = 'k-57-c-key' and status = 'ejecutada')
  or (idempotency_key = 'k-57-d-key' and status = 'aprobada');
rollback;

\echo '=== 58. zona horaria de la property: con Cancun (UTC-5) las 13:30Z son las 08:30 (dentro de la ventana) ==='
begin;
update hoteles.property_config set timezone = 'America/Cancun' where property_id = '00000000-0000-0000-0000-0000000a1a01';
select public.verify_as('');
select * from public.verify_prop('k-58-0001', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso Cancun');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-58-0001'), 'aprobar', 'Aprobado para el horario');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-58-0001'), 'ref', '2026-03-10 13:30:00+00');
select public.verify_su();
select count(*) as cancun_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-58-0001' and status = 'ejecutada';
rollback;

\echo '=== 59. una zona horaria invalida cae a Mexico_City (07:30 difiere, 08:00 ejecuta) sin error ==='
begin;
update hoteles.property_config set timezone = 'Mars/Phobos' where property_id = '00000000-0000-0000-0000-0000000a1a01';
select public.verify_as('');
select * from public.verify_prop('k-59-a-key', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso A');
select * from public.verify_prop('k-59-b-key', 'mensaje_masivo', p_rec => 10, p_text => 'Aviso B');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-59-a-key'), 'aprobar', 'Aprobado para el horario');
select * from hoteles.decide_agent_approval(public.verify_rid('k-59-b-key'), 'aprobar', 'Aprobado para el horario');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-59-a-key'), 'ref', '2026-03-10 13:30:00+00');
select * from hoteles.consume_agent_approval(public.verify_rid('k-59-b-key'), 'ref', '2026-03-10 14:00:00+00');
select public.verify_su();
select count(*) as zona_invalida_deberia_ser_2 from hoteles.agent_approval_request where
     (idempotency_key = 'k-59-a-key' and status = 'aprobada')
  or (idempotency_key = 'k-59-b-key' and status = 'ejecutada');
rollback;


-- =============================================================================
-- (g) Inmutabilidad, cancelacion, visibilidad y bitacora de las aprobaciones
-- =============================================================================

\echo '=== 60. lo propuesto es inmutable (23514) y los terminales no se tocan (55000), ni siquiera con privilegios de servicio ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-60-pend', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-60-exec', 'descuento_tarifa', p_pct => 12);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-60-exec'), 'aprobar', 'Aprobada para ejecutar');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-60-exec'), 'ref-60', '2026-06-01 13:00:00+00');
select public.verify_su();
select public.verify_expect_error($q$update hoteles.agent_approval_request set percent = 1 where idempotency_key = 'k-60-pend'$q$, '23514');
select public.verify_expect_error($q$update hoteles.agent_approval_request set payload = '{"x":1}' where idempotency_key = 'k-60-pend'$q$, '23514');
select public.verify_expect_error($q$update hoteles.agent_approval_request set action_type = 'reembolso', amount_cents = 5 where idempotency_key = 'k-60-pend'$q$, '23514');
select public.verify_expect_error($q$update hoteles.agent_approval_request set expires_at = expires_at + interval '10 days' where idempotency_key = 'k-60-pend'$q$, '23514');
select public.verify_expect_error($q$update hoteles.agent_approval_request set proposed_by = '00000000-0000-0000-0000-0000000a0a01' where idempotency_key = 'k-60-pend'$q$, '23514');
select public.verify_expect_error($q$update hoteles.agent_approval_request set status = 'ejecutada', executed_at = now() where idempotency_key = 'k-60-pend'$q$, '23514');
select public.verify_expect_error($q$update hoteles.agent_approval_request set status = 'pendiente' where idempotency_key = 'k-60-exec'$q$, '55000');
select public.verify_expect_error($q$update hoteles.agent_approval_request set execution_ref = 'otra' where idempotency_key = 'k-60-exec'$q$, '55000');
select count(*) as intactas_deberia_ser_2 from hoteles.agent_approval_request where (idempotency_key = 'k-60-pend' and percent = 10 and status = 'pendiente') or (idempotency_key = 'k-60-exec' and status = 'ejecutada' and execution_ref = 'ref-60');
rollback;

\echo '=== 61. el cliente NO escribe la cola ni las plantillas directo: INSERT/UPDATE/DELETE son 42501 (solo por las funciones) ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-61-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$insert into hoteles.agent_approval_request (property_id, agent_key, action_type, summary, percent, idempotency_key, expires_at) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', 'descuento_tarifa', 'directo', 5, 'k-61-directo', now() + interval '1 day')$q$, '42501');
select public.verify_expect_error($q$update hoteles.agent_approval_request set status = 'aprobada', decided_by = '00000000-0000-0000-0000-0000000a0a01', decided_at = now(), decision_reason = 'directo' where idempotency_key = 'k-61-0001'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.agent_approval_request where idempotency_key = 'k-61-0001'$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.agent_wa_template (property_id, agent_key, name, body, version) values ('00000000-0000-0000-0000-0000000a1a01', 'revenue', 'directa_prueba', 'hola', 1)$q$, '42501');
select public.verify_expect_error($q$update hoteles.agent_wa_template set status = 'aprobada'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.agent_event$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.agent_config$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.agent_guardrail$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.agent_action_policy$q$, '42501');
select public.verify_su();
select count(*) as sigue_pendiente_deberia_ser_1 from hoteles.agent_approval_request where idempotency_key = 'k-61-0001' and status = 'pendiente';
rollback;

\echo '=== 62. cancelar: quien propuso o owner/gm; otro autor no (42501); motivo obligatorio; solo abiertas; cancelar una aprobada impide ejecutarla ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from public.verify_prop('k-62-fd-key', 'reembolso', p_amt => 100);
select * from public.verify_prop('k-62-fd2-key', 'reembolso', p_amt => 200);
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select * from hoteles.cancel_agent_approval(public.verify_rid('k-62-fd-key'), 'no es mia pero intento')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.cancel_agent_approval(public.verify_rid('k-62-fd-key'), 'ok')$q$, '22023');
select * from hoteles.cancel_agent_approval(public.verify_rid('k-62-fd-key'), 'Me equivoque de monto');
select public.verify_expect_error($q$select * from hoteles.cancel_agent_approval(public.verify_rid('k-62-fd-key'), 'Cancelar dos veces')$q$, '55000');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from hoteles.decide_agent_approval(public.verify_rid('k-62-fd2-key'), 'aprobar', 'Aprobada y luego cancelada');
select * from hoteles.cancel_agent_approval(public.verify_rid('k-62-fd2-key'), 'Cambio de plan del huesped');
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.consume_agent_approval(public.verify_rid('k-62-fd2-key'), 'ref')$q$, '55000');
select public.verify_su();
select count(*) as canceladas_deberia_ser_2 from hoteles.agent_approval_request where idempotency_key in ('k-62-fd-key', 'k-62-fd2-key') and status = 'cancelada';
rollback;

\echo '=== 63. visibilidad (RLS): housekeeping/maintenance no ven la cola; owner B tampoco ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-63-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select count(*) as hk_deberia_ser_0 from hoteles.agent_approval_request;
rollback;

\echo '=== 64. la cola de A es invisible para owner B ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-64-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select count(*) as ob_deberia_ser_0 from hoteles.agent_approval_request;
rollback;

\echo '=== 65. frontdesk, reservations y accountant ven la cola (rol de lectura) ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-65-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select count(*) as fd_deberia_ser_1 from hoteles.agent_approval_request;
rollback;

\echo '=== 66. bitacora de una aprobacion: propuesta, aprobada, ejecutada (3) con el actor correcto; frontdesk no la lee ==='
begin;
select public.verify_as('');
select * from public.verify_prop('k-66-0001', 'descuento_tarifa', p_pct => 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.decide_agent_approval(public.verify_rid('k-66-0001'), 'aprobar', 'Aprobada para ejecutar');
select public.verify_as('');
select * from hoteles.consume_agent_approval(public.verify_rid('k-66-0001'), 'ref-66', '2026-06-01 13:00:00+00');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select count(*) as bitacora_deberia_ser_3 from hoteles.agent_event
 where subject_type = 'aprobacion' and subject_id = public.verify_rid('k-66-0001')
   and ((event_type = 'propuesta' and actor_id is null) or (event_type = 'aprobada' and actor_id = '00000000-0000-0000-0000-0000000a0a01') or (event_type = 'ejecutada' and actor_id is null));
rollback;

\echo '=== 67. bitacora: una bloqueada y una autoaprobada quedan registradas con su tipo ==='
begin;
insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_percent) values ('00000000-0000-0000-0000-0000000a1a01', 'descuento_tarifa', 'auto_bajo_umbral', 10);
select public.verify_as('');
select * from public.verify_prop('k-67-auto', 'descuento_tarifa', p_pct => 10);
select * from public.verify_prop('k-67-bloq', 'descuento_tarifa', p_pct => 99);
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select count(*) as tipos_deberia_ser_2 from hoteles.agent_event where subject_type = 'aprobacion' and
     ((event_type = 'autoaprobada' and subject_id = public.verify_rid('k-67-auto')) or (event_type = 'bloqueada' and subject_id = public.verify_rid('k-67-bloq')));
rollback;

-- =============================================================================
-- (h) Plantillas de WhatsApp versionadas con aprobacion
-- =============================================================================

\echo '=== 68. versionado: la misma plantilla (property, nombre, idioma) numera 1, 2...; otro idioma o nombre reinicia ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'bienvenida_huesped', 'es_MX', 'utility', 'Hola, bienvenido a nuestro hotel');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'bienvenida_huesped', 'es_MX', 'utility', 'Hola, bienvenido. Su habitacion esta lista');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'bienvenida_huesped', 'en_US', 'utility', 'Hello, welcome');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'otra_plantilla', 'es_MX', 'marketing', 'Promocion de temporada');
select public.verify_su();
select count(*) as versiones_deberia_ser_4 from hoteles.agent_wa_template where status = 'borrador' and created_by = '00000000-0000-0000-0000-0000000a0a03' and organization_id = '00000000-0000-0000-0000-00000000a001'
  and ((name = 'bienvenida_huesped' and language = 'es_MX' and version in (1, 2)) or (name = 'bienvenida_huesped' and language = 'en_US' and version = 1) or (name = 'otra_plantilla' and version = 1));
rollback;

\echo '=== 69. validaciones de plantilla: nombre, idioma, categoria, cuerpo vacio/largo, agente invalido (23514); roles (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'Bienvenida', 'es_MX', 'utility', 'hola')$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'ab', 'es_MX', 'utility', 'hola')$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'con espacios', 'es_MX', 'utility', 'hola')$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'valida_uno', 'fr', 'utility', 'hola')$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'valida_uno', 'es_MX', 'authentication', 'hola')$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'valida_uno', 'es_MX', 'utility', '')$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'valida_uno', 'es_MX', 'utility', repeat('x', 1025))$q$, '23514');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'hackeo', 'valida_uno', 'es_MX', 'utility', 'hola')$q$, '23514');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'valida_borde', 'es_MX', 'utility', repeat('x', 1024));
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'valida_dos', 'es_MX', 'utility', 'hola')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'valida_dos', 'es_MX', 'utility', 'hola')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'valida_dos', 'es_MX', 'utility', 'hola')$q$, '42501');
select public.verify_su();
select count(*) as solo_la_valida_deberia_ser_1 from hoteles.agent_wa_template;
rollback;

\echo '=== 70. flujo: frontdesk redacta y envia a revision; frontdesk no la aprueba (42501); gm si; queda aprobada con revisor y motivo ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'bienvenida_huesped', 'es_MX', 'utility', 'Hola, bienvenido a nuestro hotel');
select * from hoteles.submit_agent_wa_template(public.verify_tid('bienvenida_huesped', 1));
select public.verify_expect_error($q$select * from hoteles.review_agent_wa_template(public.verify_tid('bienvenida_huesped', 1), 'aprobar', 'Texto correcto')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from hoteles.review_agent_wa_template(public.verify_tid('bienvenida_huesped', 1), 'aprobar', 'Texto correcto y claro');
select public.verify_su();
select count(*) as aprobada_deberia_ser_1 from hoteles.agent_wa_template where name = 'bienvenida_huesped' and version = 1 and status = 'aprobada' and submitted_by = '00000000-0000-0000-0000-0000000a0a03' and reviewed_by = '00000000-0000-0000-0000-0000000a0a02' and review_reason = 'Texto correcto y claro';
rollback;

\echo '=== 71. ciclo estricto: no se aprueba un borrador, no se envia dos veces, no se decide dos veces; rechazar exige motivo; rechazada no se reabre (55000/22023) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'plantilla_ciclo', 'es_MX', 'utility', 'Version uno');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'plantilla_ciclo', 'es_MX', 'utility', 'Version dos');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_ciclo', 1), 'aprobar', 'Todavia es borrador')$q$, '55000');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.submit_agent_wa_template(public.verify_tid('plantilla_ciclo', 1));
select public.verify_expect_error($q$select * from hoteles.submit_agent_wa_template(public.verify_tid('plantilla_ciclo', 1))$q$, '55000');
select * from hoteles.submit_agent_wa_template(public.verify_tid('plantilla_ciclo', 2));
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_ciclo', 1), 'rechazar', null)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_ciclo', 1), 'rechazar', 'no')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_ciclo', 1), 'quiza', 'motivo valido')$q$, '22023');
select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_ciclo', 1), 'rechazar', 'Falta el nombre del hotel');
select public.verify_expect_error($q$select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_ciclo', 1), 'aprobar', 'Reabrir la rechazada')$q$, '55000');
select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_ciclo', 2), 'aprobar', 'Ahora si esta completa');
select public.verify_expect_error($q$select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_ciclo', 2), 'rechazar', 'Cambiar de opinion')$q$, '55000');
select public.verify_su();
select count(*) as estados_deberia_ser_2 from hoteles.agent_wa_template where name = 'plantilla_ciclo' and ((version = 1 and status = 'rechazada' and review_reason = 'Falta el nombre del hotel') or (version = 2 and status = 'aprobada'));
rollback;

\echo '=== 72. separacion de funciones: gm no aprueba lo que el mismo envio (42501); otro gm si; el dueno si puede con la suya ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'plantilla_gm', 'es_MX', 'utility', 'Texto del gm');
select * from hoteles.submit_agent_wa_template(public.verify_tid('plantilla_gm', 1));
select public.verify_expect_error($q$select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_gm', 1), 'aprobar', 'Me la apruebo yo mismo')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_gm', 1), 'rechazar', 'Me la rechazo yo mismo')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a0a');
select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_gm', 1), 'aprobar', 'Revisada por el segundo gerente');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'plantilla_dueno', 'es_MX', 'utility', 'Texto del dueno');
select * from hoteles.submit_agent_wa_template(public.verify_tid('plantilla_dueno', 1));
select * from hoteles.review_agent_wa_template(public.verify_tid('plantilla_dueno', 1), 'aprobar', 'El dueno aprueba la suya');
select public.verify_su();
select count(*) as aprobadas_deberia_ser_2 from hoteles.agent_wa_template where status = 'aprobada' and name in ('plantilla_gm', 'plantilla_dueno');
rollback;

\echo '=== 73. una sola version aprobada por (property, nombre, idioma): aprobar la 2 archiva la 1; el indice unico lo garantiza aun por fuera (23505) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'una_vigente', 'es_MX', 'utility', 'Version uno');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'una_vigente', 'es_MX', 'utility', 'Version dos');
select * from hoteles.submit_agent_wa_template(public.verify_tid('una_vigente', 1));
select * from hoteles.submit_agent_wa_template(public.verify_tid('una_vigente', 2));
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from hoteles.review_agent_wa_template(public.verify_tid('una_vigente', 1), 'aprobar', 'Primera version vigente');
select * from hoteles.review_agent_wa_template(public.verify_tid('una_vigente', 2), 'aprobar', 'Segunda version vigente');
select public.verify_su();
select public.verify_expect_error($q$update hoteles.agent_wa_template set status = 'aprobada' where name = 'una_vigente' and version = 1$q$, '23514');
select count(*) as una_vigente_deberia_ser_2 from hoteles.agent_wa_template where name = 'una_vigente' and ((version = 1 and status = 'archivada') or (version = 2 and status = 'aprobada'));
rollback;

\echo '=== 74. el texto de una plantilla es inmutable (23514), tambien con privilegios de servicio; archivar solo owner/gm y solo aprobada/rechazada ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'inmutable_uno', 'es_MX', 'utility', 'Texto original');
select public.verify_su();
select public.verify_expect_error($q$update hoteles.agent_wa_template set body = 'Texto cambiado' where name = 'inmutable_uno'$q$, '23514');
select public.verify_expect_error($q$update hoteles.agent_wa_template set version = 9 where name = 'inmutable_uno'$q$, '23514');
select public.verify_expect_error($q$update hoteles.agent_wa_template set name = 'otro_nombre' where name = 'inmutable_uno'$q$, '23514');
select public.verify_expect_error($q$update hoteles.agent_wa_template set status = 'aprobada' where name = 'inmutable_uno'$q$, '23514');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.submit_agent_wa_template(public.verify_tid('inmutable_uno', 1));
select public.verify_expect_error($q$select * from hoteles.archive_agent_wa_template(public.verify_tid('inmutable_uno', 1))$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$select * from hoteles.archive_agent_wa_template(public.verify_tid('inmutable_uno', 1))$q$, '55000');
select * from hoteles.review_agent_wa_template(public.verify_tid('inmutable_uno', 1), 'aprobar', 'Texto aprobado para archivar');
select * from hoteles.archive_agent_wa_template(public.verify_tid('inmutable_uno', 1));
select public.verify_su();
select count(*) as archivada_deberia_ser_1 from hoteles.agent_wa_template where name = 'inmutable_uno' and status = 'archivada' and body = 'Texto original';
rollback;

\echo '=== 75. una plantilla con palabra bloqueada por los guardrails no se crea (23514) ==='
begin;
insert into hoteles.agent_guardrail (property_id, blocked_words) values ('00000000-0000-0000-0000-0000000a1a01', array['gratis']);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'con_palabra', 'es_MX', 'marketing', 'Noche GRATIS para usted')$q$, '23514');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'sin_palabra', 'es_MX', 'marketing', 'Gratisimo no cuenta');
select public.verify_su();
select count(*) as solo_sin_palabra_deberia_ser_1 from hoteles.agent_wa_template where name in ('con_palabra', 'sin_palabra');
rollback;

\echo '=== 76. visibilidad de plantillas: housekeeping no las ve; owner B tampoco; la bitacora registra creada/enviada/aprobada ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'visibles_uno', 'es_MX', 'utility', 'Texto visible');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select count(*) as ob_plantillas_deberia_ser_0 from hoteles.agent_wa_template;
rollback;

\echo '=== 77. housekeeping no ve plantillas ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'visibles_dos', 'es_MX', 'utility', 'Texto visible');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select count(*) as hk_plantillas_deberia_ser_0 from hoteles.agent_wa_template;
rollback;

\echo '=== 78. bitacora de plantilla: creada, enviada, aprobada (3) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.create_agent_wa_template('00000000-0000-0000-0000-0000000a1a01', 'recepcion_whatsapp', 'bitacora_uno', 'es_MX', 'utility', 'Texto con bitacora');
select * from hoteles.submit_agent_wa_template(public.verify_tid('bitacora_uno', 1));
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from hoteles.review_agent_wa_template(public.verify_tid('bitacora_uno', 1), 'aprobar', 'Aprobada con bitacora');
select count(*) as bitacora_deberia_ser_3 from hoteles.agent_event where subject_type = 'plantilla' and subject_id = public.verify_tid('bitacora_uno', 1)
   and event_type in ('plantilla_creada', 'plantilla_pendiente', 'plantilla_aprobada');
rollback;

-- =============================================================================
-- (i) Metaverificaciones de seguridad de las funciones
-- =============================================================================

\echo '=== 79. toda funcion definer del modulo fija search_path ==='
begin;
select count(*) as sin_search_path_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'hoteles' and p.prosecdef
   and p.proname in ('agent_vertical_role', 'can_view_agents', 'can_manage_agents', 'can_author_agent_content', 'agent_approver_ok', 'agent_log',
     'agent_config_before_write', 'agent_config_log', 'agent_guardrail_before_write', 'agent_guardrail_log', 'agent_policy_before_write', 'agent_policy_log',
     'agent_approval_before_update', 'agent_approval_log', 'agent_wa_template_before_update', 'agent_wa_template_log', 'record_agent_usage', 'agent_gate',
     'expire_agent_approvals', 'agent_guardrail_violation', 'within_send_window', 'propose_agent_action', 'decide_agent_approval', 'consume_agent_approval',
     'cancel_agent_approval', 'create_agent_wa_template', 'submit_agent_wa_template', 'review_agent_wa_template', 'archive_agent_wa_template')
   and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%');
rollback;

\echo '=== 80. ninguna funcion del modulo es ejecutable por anon ni por public ==='
begin;
select count(*) as anon_ejecuta_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'hoteles'
   and p.proname in ('agent_vertical_role', 'can_view_agents', 'can_manage_agents', 'can_author_agent_content', 'agent_approver_ok', 'agent_log', 'agent_clock',
     'guardrail_normalize', 'guardrail_first_blocked_word', 'record_agent_usage', 'agent_gate', 'expire_agent_approvals', 'agent_guardrail_violation',
     'within_send_window', 'propose_agent_action', 'decide_agent_approval', 'consume_agent_approval', 'cancel_agent_approval', 'create_agent_wa_template',
     'submit_agent_wa_template', 'review_agent_wa_template', 'archive_agent_wa_template')
   and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));
rollback;

\echo '=== 81. las funciones internas (agent_log, guardrail_violation, within_send_window) no son ejecutables por authenticated ==='
begin;
select count(*) as authenticated_interno_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'hoteles' and p.proname in ('agent_log', 'agent_guardrail_violation', 'within_send_window') and has_function_privilege('authenticated', p.oid, 'execute');
rollback;

\echo '=== 82. ninguna policy del modulo usa using (true) y ninguna tabla tiene grants a anon ==='
begin;
select count(*) as policies_abiertas_deberia_ser_0 from pg_policies where schemaname = 'hoteles' and tablename like 'agent\_%' and (qual = 'true' or with_check = 'true');
rollback;

\echo '=== 83. con la tabla de aprobaciones ELIMINADA (42P01) el SAVEPOINT recupera la transaccion y el resto sigue funcionando ==='
begin;
drop table hoteles.agent_approval_request cascade;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
savepoint sp_verify_agentes_missing;
do $$
declare
  v_state text;
begin
  begin
    perform count(*) from hoteles.agent_approval_request;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_agentes_missing;
release savepoint sp_verify_agentes_missing;
select count(*) as catalogo_sigue_deberia_ser_0 from hoteles.agent_config;
rollback;

\echo '=== 84. control: tras el DDL destructivo revertido la cola existe ==='
begin;
select count(*) as cola_intacta_deberia_ser_0 from hoteles.agent_approval_request;
rollback;

