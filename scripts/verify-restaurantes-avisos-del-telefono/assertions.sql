-- Fixtures + escenarios contra Postgres REAL (GRANT + auth.uid() reales) de packages/domain-restaurantes/migrations/193_avisos_del_telefono.sql.
--
--   A. Positivo: la sesion de sistema (rol authenticated SIN auth.uid()) lee los avisos del telefono en su organizacion, del mas reciente al mas viejo,
--      con resolved y created_at; la ventana p_horas se respeta y se recorta a 48 h.
--   B. Aislamiento: nunca devuelve avisos de otro telefono ni de otra organizacion (cross-tenant).
--   C. Autorizacion: un usuario autenticado (auth.uid() no nulo) -> 42501; anon -> 42501; parametros nulos -> 22023.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; los alias con sufijo deberia_ser_N marcan el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.t_esperar_error(p_sql text, p_estado text) returns void
language plpgsql as $$
declare
  v text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v = returned_sqlstate;
    if v <> p_estado then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_estado, v, sqlerrm;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE % y la sentencia no fallo', p_estado;
end $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f1901', 'restaurantes', 'Avisos Tel Org A', 'avisos-tel-a'),
  ('00000000-0000-0000-0000-0000000f1902', 'restaurantes', 'Avisos Tel Org B', 'avisos-tel-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f1911', 'owner-a@avisostel.example.com', 'Owner A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f1911', '00000000-0000-0000-0000-0000000f1901', null, 'owner', 'owner')
on conflict do nothing;

-- a1: alergia abierta hace 10 min; a2: queja resuelta hace 2 h; a3: hace 50 h (fuera de 48 h); a4: OTRO telefono en A; b1: mismo telefono en ORG B.
insert into restaurantes.callback_requests (id, organization_id, customer_name, customer_phone, reason, message, source, resolved, created_at) values
  ('00000000-0000-0000-0000-0000000f19c1', '00000000-0000-0000-0000-0000000f1901', 'Cliente', '+5219990000001', 'escalada:alergia_salud', 'alergia al cacahuate', 'whatsapp', false, now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000f19c2', '00000000-0000-0000-0000-0000000f1901', 'Cliente', '+5219990000001', 'escalada:queja', 'llego frio', 'whatsapp', true, now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000f19c3', '00000000-0000-0000-0000-0000000f1901', 'Cliente', '+5219990000001', 'escalada:queja', 'viejo', 'whatsapp', false, now() - interval '50 hours'),
  ('00000000-0000-0000-0000-0000000f19c4', '00000000-0000-0000-0000-0000000f1901', 'Otro', '+5219990000002', 'escalada:queja', 'otro telefono', 'whatsapp', false, now() - interval '5 minutes'),
  ('00000000-0000-0000-0000-0000000f19c5', '00000000-0000-0000-0000-0000000f1902', 'Cliente', '+5219990000001', 'escalada:queja', 'otra organizacion', 'whatsapp', false, now() - interval '5 minutes');

\echo '=== A1. Sistema: los avisos del telefono en su organizacion (48 h), del mas reciente al mas viejo ==='
begin;
set local role authenticated;
select count(*) as avisos_48h_deberia_ser_2 from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', '+5219990000001', 48);
select ((array_agg(id order by ord))[1] = '00000000-0000-0000-0000-0000000f19c1')::int as el_primero_es_el_mas_reciente_deberia_ser_1
  from (select id, row_number() over () as ord from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', '+5219990000001', 48)) x;
select count(*) as abiertos_deberia_ser_1 from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', '+5219990000001', 48) where resolved = false;
rollback;

\echo '=== A2. Ventana: 1 h solo ve el de hace 10 min; 500 h se recorta a 48 h ==='
begin;
set local role authenticated;
select count(*) as avisos_1h_deberia_ser_1 from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', '+5219990000001', 1);
select count(*) as avisos_recortado_deberia_ser_2 from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', '+5219990000001', 500);
rollback;

\echo '=== B1. Aislamiento: ni otro telefono ni otra organizacion (cross-tenant) ==='
begin;
set local role authenticated;
select count(*) as de_otro_tenant_deberia_ser_0 from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', '+5219990000001', 48) where id in ('00000000-0000-0000-0000-0000000f19c4', '00000000-0000-0000-0000-0000000f19c5');
select count(*) as org_b_deberia_ser_1 from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1902', '+5219990000001', 48);
rollback;

\echo '=== C1. RECHAZADO: un usuario autenticado (auth.uid() no nulo) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1911', true);
select public.t_esperar_error($q$select * from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', '+5219990000001', 48)$q$, '42501');
rollback;

\echo '=== C2. RECHAZADO: anon no ejecuta la funcion -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', '+5219990000001', 48)$q$, '42501');
rollback;

\echo '=== C3. RECHAZADO: parametros nulos o telefono vacio -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.avisos_del_telefono(null, '+5219990000001', 48)$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', ' ', 48)$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.avisos_del_telefono('00000000-0000-0000-0000-0000000f1901', '+5219990000001', null)$q$, '22023');
rollback;

\echo '=== D. avisos_urgentes_sin_resolver: solo URGENTE sin resolver de organizaciones con cerebro_v2, pasado el umbral y dentro de 24 h ==='
insert into restaurantes.agent_runtime_settings (organization_id, cerebro_v2) values ('00000000-0000-0000-0000-0000000f1901', true)
on conflict (organization_id) do update set cerebro_v2 = true;
-- u1: urgente abierta hace 30 min (sale); u2: urgente RESUELTA (no); u3: urgente hace 3 min (no: antes del umbral); u4: no urgente (no); u5: urgente en ORG B sin cerebro_v2 (no).
insert into restaurantes.callback_requests (id, organization_id, customer_name, customer_phone, reason, message, source, resolved, created_at) values
  ('00000000-0000-0000-0000-0000000f19d1', '00000000-0000-0000-0000-0000000f1901', 'Cliente', '+5219990000003', 'escalada:alergia_salud', 'URGENTE: el cliente pide atención inmediata.' || chr(10) || 'alergia', 'whatsapp', false, now() - interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000f19d2', '00000000-0000-0000-0000-0000000f1901', 'Cliente', '+5219990000003', 'escalada:alergia_salud', 'URGENTE: ya resuelta', 'whatsapp', true, now() - interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000f19d3', '00000000-0000-0000-0000-0000000f1901', 'Cliente', '+5219990000004', 'escalada:alergia_salud', 'URGENTE: reciente', 'whatsapp', false, now() - interval '3 minutes'),
  ('00000000-0000-0000-0000-0000000f19d4', '00000000-0000-0000-0000-0000000f1901', 'Cliente', '+5219990000005', 'escalada:queja', 'no urgente', 'whatsapp', false, now() - interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000f19d5', '00000000-0000-0000-0000-0000000f1902', 'Cliente', '+5219990000006', 'escalada:alergia_salud', 'URGENTE: otra org', 'whatsapp', false, now() - interval '30 minutes');

begin;
set local role authenticated;
select count(*) as urgentes_deberia_ser_1 from restaurantes.avisos_urgentes_sin_resolver(now(), 10);
select count(*) as es_u1_deberia_ser_1 from restaurantes.avisos_urgentes_sin_resolver(now(), 10) where id = '00000000-0000-0000-0000-0000000f19d1';
rollback;

\echo '=== D2. RECHAZADO: autenticado -> 42501; anon -> 42501; umbral fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1911', true);
select public.t_esperar_error($q$select * from restaurantes.avisos_urgentes_sin_resolver(now(), 10)$q$, '42501');
rollback;
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.avisos_urgentes_sin_resolver(now(), 10)$q$, '42501');
rollback;
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.avisos_urgentes_sin_resolver(now(), 0)$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.avisos_urgentes_sin_resolver(null, 10)$q$, '22023');
rollback;

\echo 'Todos los escenarios terminan con la expectativa del propio archivo: RECHAZADO = sin ERROR dentro de t_esperar_error (el helper exige el SQLSTATE exacto); alias deberia_ser_N = valor exacto.'
