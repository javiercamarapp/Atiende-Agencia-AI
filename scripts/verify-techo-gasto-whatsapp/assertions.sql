-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), packages/db/migrations/0102_whatsapp_agente_techo.sql (Ola 4, H1):
--   S) lectura de SISTEMA del gasto del mes del agente de WhatsApp (LLM del agente + costo de WhatsApp) y de la configuracion de la
--      organizacion (umbrales de aviso y corte; sin fila = null: el API usa sus umbrales de omision y NUNCA corta).
--   N) negativos: usuario real o anon no leen el estado de nadie (42501 / sin EXECUTE).
--   C) configurar (superadmin caller-bound, no restringido): umbrales informativos y, solo si se pide explicito, un corte; valida,
--      borra (vuelve a omision: sin corte) y deja historial.
--   X) cross-tenant y acceso directo: nadie lee ni escribe las tablas directo.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback propio; `should_fail`
-- marca un escenario que debe terminar en ERROR; deberia_ser_N exige que la ultima fila valga N; el resto debe completar sin error.
-- Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-00000000c100', 'restaurantes', 'Org A techo', 'org-techo-a', 'active'),
  ('00000000-0000-0000-0000-00000000c101', 'restaurantes', 'Org B techo', 'org-techo-b', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000c200', 'sa-techo@example.com', 'Superadmin techo', 'seed'),
  ('00000000-0000-0000-0000-00000000c201', 'owner-techo@example.com', 'Owner org A', 'seed'),
  ('00000000-0000-0000-0000-00000000c202', 'fin-techo@example.com', 'Finanzas techo', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-00000000c200'), ('00000000-0000-0000-0000-00000000c202') on conflict do nothing;
insert into core.cfo_zone_role (staff_user_id, rol, reason) values ('00000000-0000-0000-0000-00000000c202', 'finanzas', 'rol de finanzas para la verificacion del techo') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000c100', '{}', 'owner', 'owner')
on conflict do nothing;
-- Uso de este mes: 3 USD del agente (2 roles) + 1 USD de otro rol (no cuenta) + 5 USD de la org B (no cuenta) + 2 USD del mes pasado (no cuenta).
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-00000000c100', (now() at time zone 'America/Merida')::date, 'restaurantes', 'restaurantes:whatsapp_agent', 'openrouter', 'm1', 'interactive', 2000000, 10),
  ('00000000-0000-0000-0000-00000000c100', (now() at time zone 'America/Merida')::date, 'restaurantes', 'restaurantes:whatsapp_agent_escalated', 'openrouter', 'm2', 'interactive', 1000000, 2),
  ('00000000-0000-0000-0000-00000000c100', (now() at time zone 'America/Merida')::date, 'restaurantes', 'restaurantes:data_chat', 'openrouter', 'm1', 'interactive', 1000000, 1),
  ('00000000-0000-0000-0000-00000000c101', (now() at time zone 'America/Merida')::date, 'restaurantes', 'restaurantes:whatsapp_agent', 'openrouter', 'm1', 'interactive', 5000000, 9),
  ('00000000-0000-0000-0000-00000000c100', ((date_trunc('month', now() at time zone 'America/Merida'))::date - 3), 'restaurantes', 'restaurantes:whatsapp_agent', 'openrouter', 'm1', 'interactive', 2000000, 4)
on conflict do nothing;
-- Costo de WhatsApp (Meta) de este mes: 0.5 USD de la org A.
insert into core.usage_cost_event (organization_id, vertical, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-00000000c100', 'restaurantes', 'whatsapp', 'meta', 'conversacion', 1, 500000, 'techo_verify', 'c100-1'),
  ('00000000-0000-0000-0000-00000000c100', 'restaurantes', 'voz', 'gemini', 'minuto', 1, 900000, 'techo_verify', 'c100-voz')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-00000000c100', 'restaurantes', 'Org A techo', 'org-techo-a', 'active'),
  ('00000000-0000-0000-0000-00000000c101', 'restaurantes', 'Org B techo', 'org-techo-b', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000c200', 'sa-techo@example.com', 'Superadmin techo', 'seed'),
  ('00000000-0000-0000-0000-00000000c201', 'owner-techo@example.com', 'Owner org A', 'seed'),
  ('00000000-0000-0000-0000-00000000c202', 'fin-techo@example.com', 'Finanzas techo', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-00000000c200'), ('00000000-0000-0000-0000-00000000c202') on conflict do nothing;
insert into core.cfo_zone_role (staff_user_id, rol, reason) values ('00000000-0000-0000-0000-00000000c202', 'finanzas', 'rol de finanzas para la verificacion del techo') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000c100', '{}', 'owner', 'owner')
on conflict do nothing;
-- Uso de este mes: 3 USD del agente (2 roles) + 1 USD de otro rol (no cuenta) + 5 USD de la org B (no cuenta) + 2 USD del mes pasado (no cuenta).
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-00000000c100', (now() at time zone 'America/Merida')::date, 'restaurantes', 'restaurantes:whatsapp_agent', 'openrouter', 'm1', 'interactive', 2000000, 10),
  ('00000000-0000-0000-0000-00000000c100', (now() at time zone 'America/Merida')::date, 'restaurantes', 'restaurantes:whatsapp_agent_escalated', 'openrouter', 'm2', 'interactive', 1000000, 2),
  ('00000000-0000-0000-0000-00000000c100', (now() at time zone 'America/Merida')::date, 'restaurantes', 'restaurantes:data_chat', 'openrouter', 'm1', 'interactive', 1000000, 1),
  ('00000000-0000-0000-0000-00000000c101', (now() at time zone 'America/Merida')::date, 'restaurantes', 'restaurantes:whatsapp_agent', 'openrouter', 'm1', 'interactive', 5000000, 9),
  ('00000000-0000-0000-0000-00000000c100', ((date_trunc('month', now() at time zone 'America/Merida'))::date - 3), 'restaurantes', 'restaurantes:whatsapp_agent', 'openrouter', 'm1', 'interactive', 2000000, 4)
on conflict do nothing;
-- Costo de WhatsApp (Meta) de este mes: 0.5 USD de la org A.
insert into core.usage_cost_event (organization_id, vertical, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-00000000c100', 'restaurantes', 'whatsapp', 'meta', 'conversacion', 1, 500000, 'techo_verify', 'c100-1'),
  ('00000000-0000-0000-0000-00000000c100', 'restaurantes', 'voz', 'gemini', 'minuto', 1, 900000, 'techo_verify', 'c100-voz')
on conflict do nothing;

-- S1) sistema: gasto 3.5 USD (2 + 1 del agente + 0.5 WhatsApp; ni data_chat, ni voz, ni org B, ni mes pasado).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select gasto_micro_usd as deberia_ser_3500000 from core.whatsapp_agente_techo_estado_for_system('00000000-0000-0000-0000-00000000c100');
rollback;

-- S2) sistema, sin fila: SIN corte y sin umbrales propios (null = omision del API), periodo del mes local y el slug.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.whatsapp_agente_techo_estado_for_system('00000000-0000-0000-0000-00000000c100')
  where corte_micro_usd is null and umbrales_aviso_micro_usd is null and slug = 'org-techo-a'
    and periodo = to_char(now() at time zone 'America/Merida', 'YYYY-MM');
rollback;

-- S3) con fila configurada mandan sus umbrales y su corte.
begin;
insert into core.whatsapp_agente_techo (organization_id, umbrales_aviso_micro_usd, corte_micro_usd) values ('00000000-0000-0000-0000-00000000c100', '{20000000,40000000}', 90000000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.whatsapp_agente_techo_estado_for_system('00000000-0000-0000-0000-00000000c100')
  where umbrales_aviso_micro_usd = '{20000000,40000000}'::bigint[] and corte_micro_usd = 90000000;
rollback;

-- N1) un usuario real (owner de la org) no lee el estado: 42501.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c201', true);
select count(*) as should_fail from core.whatsapp_agente_techo_estado_for_system('00000000-0000-0000-0000-00000000c100');
rollback;

-- N2) anon: sin EXECUTE.
begin;
set local role anon;
select count(*) as should_fail from core.whatsapp_agente_techo_estado_for_system('00000000-0000-0000-0000-00000000c100');
rollback;

-- C1) superadmin fija solo umbrales (sin corte): queda la fila con corte null.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c200', true);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c200', '00000000-0000-0000-0000-00000000c100', '{30000000,60000000}', null);
reset role;
select count(*) as deberia_ser_1 from core.whatsapp_agente_techo where organization_id = '00000000-0000-0000-0000-00000000c100'
  and corte_micro_usd is null and umbrales_aviso_micro_usd = '{30000000,60000000}'::bigint[] and updated_by = '00000000-0000-0000-0000-00000000c200';
rollback;

-- C2) el corte solo existe si se pide explicito; cada cambio deja historial (quien, que, cuando).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c200', true);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c200', '00000000-0000-0000-0000-00000000c100', null, 300000000);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c200', '00000000-0000-0000-0000-00000000c100', null, null);
reset role;
select count(*) as deberia_ser_2 from core.whatsapp_agente_techo_evento where organization_id = '00000000-0000-0000-0000-00000000c100' and actor_user_id = '00000000-0000-0000-0000-00000000c200';
rollback;

-- C3) umbrales y corte nulos borran la fila: la organizacion vuelve a la omision (sin corte).
begin;
insert into core.whatsapp_agente_techo (organization_id, corte_micro_usd) values ('00000000-0000-0000-0000-00000000c100', 40000000);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c200', true);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c200', '00000000-0000-0000-0000-00000000c100', null, null);
reset role;
select count(*) as deberia_ser_0 from core.whatsapp_agente_techo where organization_id = '00000000-0000-0000-0000-00000000c100';
rollback;

-- C4) el owner de la organizacion NO configura (solo superadmin).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c201', true);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-00000000c100', null, 999000000) as should_fail;
rollback;

-- C5) caller-binding roto: 42501.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c201', true);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c200', '00000000-0000-0000-0000-00000000c100', null, 50000000) as should_fail;
rollback;

-- C6) superadmin restringido (finanzas) es de solo lectura.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c202', true);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c202', '00000000-0000-0000-0000-00000000c100', null, 50000000) as should_fail;
rollback;

-- C7) un umbral no positivo: error.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c200', true);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c200', '00000000-0000-0000-0000-00000000c100', '{50000000,0}', null) as should_fail;
rollback;

-- C8) un corte no positivo: error.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c200', true);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c200', '00000000-0000-0000-0000-00000000c100', null, -5) as should_fail;
rollback;

-- C9) sesion de sistema tampoco configura (no hay superadmin detras).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_set_whatsapp_agente_techo('00000000-0000-0000-0000-00000000c200', '00000000-0000-0000-0000-00000000c100', null, 50000000) as should_fail;
rollback;

-- X1) acceso directo a la tabla de configuracion como authenticated: error.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c201', true);
select count(*) as should_fail from core.whatsapp_agente_techo;
rollback;

-- X2) acceso directo al historial como authenticated: error.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c200', true);
select count(*) as should_fail from core.whatsapp_agente_techo_evento;
rollback;

-- X3) funciones: security definer, search_path fijo, sin EXECUTE para public ni anon.
begin;
select count(*) as deberia_ser_2
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core' and p.proname in ('whatsapp_agente_techo_estado_for_system', 'superadmin_set_whatsapp_agente_techo')
  and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
  and not has_function_privilege('public', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute');
rollback;
