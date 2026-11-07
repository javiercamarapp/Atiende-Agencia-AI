-- Fixtures + escenarios contra Postgres REAL (GRANT + auth.uid() reales) de packages/domain-restaurantes/migrations/194_avisos_correo_escalera.sql.
--
--   A. Positivo: la sesion de sistema (rol authenticated SIN auth.uid()) ve los avisos sin resolver de la organizacion con cerebro_v2 y la opcion encendida:
--      pasados 10 min, o urgentes aunque sean recientes; marca urgente y posible baja.
--   B. Negativos y aislamiento: ni resueltos, ni recientes no urgentes, ni de mas de 24 h, ni de una organizacion sin la opcion (cross-tenant); el equipo solo de
--      la organizacion pedida y solo con la opcion encendida.
--   C. Autorizacion: un usuario autenticado (auth.uid() no nulo) -> 42501; anon -> 42501; parametros invalidos -> 22023; la opcion no la escribe `authenticated`.
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
  ('00000000-0000-0000-0000-0000000f1941', 'restaurantes', 'Avisos Correo Org A', 'avisos-correo-a'),
  ('00000000-0000-0000-0000-0000000f1942', 'restaurantes', 'Avisos Correo Org B', 'avisos-correo-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f1951', 'owner-a@avisoscorreo.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f1952', 'staff-a@avisoscorreo.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000f1953', 'owner-b@avisoscorreo.example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f1951', '00000000-0000-0000-0000-0000000f1941', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f1952', '00000000-0000-0000-0000-0000000f1941', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f1953', '00000000-0000-0000-0000-0000000f1942', null, 'owner', 'owner')
on conflict do nothing;

-- ORG A: cerebro_v2 + opcion; ORG B: cerebro_v2 SIN la opcion.
insert into restaurantes.agent_runtime_settings (organization_id, cerebro_v2, avisos_correo_escalera) values
  ('00000000-0000-0000-0000-0000000f1941', true, true),
  ('00000000-0000-0000-0000-0000000f1942', true, false)
on conflict (organization_id) do update set cerebro_v2 = excluded.cerebro_v2, avisos_correo_escalera = excluded.avisos_correo_escalera;

-- c1: abierto hace 30 min (sale); c2: urgente hace 2 min (sale); c3: posible baja hace 40 min (sale, solo nivel 1); c4: resuelto (no); c5: reciente no urgente (no);
-- c6: hace 30 h (no); c7: ORG B sin la opcion (no).
insert into restaurantes.callback_requests (id, organization_id, customer_name, customer_phone, reason, message, source, resolved, created_at) values
  ('00000000-0000-0000-0000-0000000f19e1', '00000000-0000-0000-0000-0000000f1941', 'Cliente', '+5219990000011', 'escalada:queja', 'llego frio', 'whatsapp', false, now() - interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000f19e2', '00000000-0000-0000-0000-0000000f1941', 'Cliente', '+5219990000012', 'escalada:alergia_salud', 'URGENTE: el cliente pide atención inmediata.' || chr(10) || 'alergia', 'whatsapp', false, now() - interval '2 minutes'),
  ('00000000-0000-0000-0000-0000000f19e3', '00000000-0000-0000-0000-0000000f1941', 'Cliente', '+5219990000013', 'escalada:cancelacion_modificacion', '[posible baja: el cliente duda o pregunto por cancelar] ya no lo quiero', 'whatsapp', false, now() - interval '40 minutes'),
  ('00000000-0000-0000-0000-0000000f19e4', '00000000-0000-0000-0000-0000000f1941', 'Cliente', '+5219990000014', 'escalada:queja', 'resuelto', 'whatsapp', true, now() - interval '30 minutes'),
  ('00000000-0000-0000-0000-0000000f19e5', '00000000-0000-0000-0000-0000000f1941', 'Cliente', '+5219990000015', 'escalada:queja', 'reciente', 'whatsapp', false, now() - interval '3 minutes'),
  ('00000000-0000-0000-0000-0000000f19e6', '00000000-0000-0000-0000-0000000f1941', 'Cliente', '+5219990000016', 'escalada:queja', 'viejo', 'whatsapp', false, now() - interval '30 hours'),
  ('00000000-0000-0000-0000-0000000f19e7', '00000000-0000-0000-0000-0000000f1942', 'Cliente', '+5219990000017', 'escalada:queja', 'otra org', 'whatsapp', false, now() - interval '30 minutes');

\echo '=== A1. Sistema: avisos para correo (umbral 10 min, urgentes de inmediato) ==='
begin;
set local role authenticated;
select count(*) as avisos_deberia_ser_3 from restaurantes.avisos_para_correo(now(), 10);
select count(*) as urgente_marcado_deberia_ser_1 from restaurantes.avisos_para_correo(now(), 10) where urgente and id = '00000000-0000-0000-0000-0000000f19e2';
select count(*) as posible_baja_marcada_deberia_ser_1 from restaurantes.avisos_para_correo(now(), 10) where solo_primer_aviso and id = '00000000-0000-0000-0000-0000000f19e3';
rollback;

\echo '=== A2. Sistema: el equipo de la organizacion con la opcion encendida ==='
begin;
set local role authenticated;
select count(*) as equipo_a_deberia_ser_2 from restaurantes.equipo_para_avisos_correo('00000000-0000-0000-0000-0000000f1941');
select count(*) as duenos_a_deberia_ser_1 from restaurantes.equipo_para_avisos_correo('00000000-0000-0000-0000-0000000f1941') where vertical_role = 'owner';
rollback;

\echo '=== B1. Negativos: resueltos, recientes no urgentes, viejos y otra organizacion no salen ==='
begin;
set local role authenticated;
select count(*) as excluidos_deberia_ser_0 from restaurantes.avisos_para_correo(now(), 10)
  where id in ('00000000-0000-0000-0000-0000000f19e4', '00000000-0000-0000-0000-0000000f19e5', '00000000-0000-0000-0000-0000000f19e6', '00000000-0000-0000-0000-0000000f19e7');
rollback;

\echo '=== B2. Aislamiento: el equipo de una organizacion SIN la opcion es vacio (y nunca el de otra) ==='
begin;
set local role authenticated;
select count(*) as equipo_b_deberia_ser_0 from restaurantes.equipo_para_avisos_correo('00000000-0000-0000-0000-0000000f1942');
select count(*) as correo_de_b_en_a_deberia_ser_0 from restaurantes.equipo_para_avisos_correo('00000000-0000-0000-0000-0000000f1941') where email = 'owner-b@avisoscorreo.example.com';
rollback;

\echo '=== B3. Apagada la opcion en A, nada sale (ni avisos ni equipo) ==='
begin;
update restaurantes.agent_runtime_settings set avisos_correo_escalera = false where organization_id = '00000000-0000-0000-0000-0000000f1941';
set local role authenticated;
select count(*) as apagada_avisos_deberia_ser_0 from restaurantes.avisos_para_correo(now(), 10);
select count(*) as apagada_equipo_deberia_ser_0 from restaurantes.equipo_para_avisos_correo('00000000-0000-0000-0000-0000000f1941');
rollback;

\echo '=== C1. RECHAZADO: un usuario autenticado (auth.uid() no nulo) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1951', true);
select public.t_esperar_error($q$select * from restaurantes.avisos_para_correo(now(), 10)$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.equipo_para_avisos_correo('00000000-0000-0000-0000-0000000f1941')$q$, '42501');
rollback;

\echo '=== C2. RECHAZADO: anon no ejecuta las funciones -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.avisos_para_correo(now(), 10)$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.equipo_para_avisos_correo('00000000-0000-0000-0000-0000000f1941')$q$, '42501');
rollback;

\echo '=== C3. RECHAZADO: parametros invalidos -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.avisos_para_correo(null, 10)$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.avisos_para_correo(now(), 0)$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.avisos_para_correo(now(), 121)$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.equipo_para_avisos_correo(null)$q$, '22023');
rollback;

\echo '=== C4. RECHAZADO: authenticated no enciende la opcion (sin GRANT de update) -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$update restaurantes.agent_runtime_settings set avisos_correo_escalera = true where organization_id = '00000000-0000-0000-0000-0000000f1942'$q$, '42501');
rollback;
