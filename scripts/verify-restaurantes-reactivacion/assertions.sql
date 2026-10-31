-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/150_reactivacion_automatica.sql (reactivacion automatica de clientes dormidos + opt-in conversacional):
--   A. Universo opt-in: sin consentimiento 'otorgado' NADIE es candidato (hoy 0); revocado (BAJA) sale al instante; fuera de la ventana 14-21 d no entra; modo apagado = 0.
--   B. Favorito, interruptor por sucursal (apagada por omision), queja reciente y topes de frecuencia visibles en los candidatos.
--   C. Registro idempotente por persona y dia; control; configuracion (rangos, 'real' exige simulacion previa); autorizacion (owner/admin, cross-tenant, anon, solo-sistema).
--   D. Opt-in conversacional: una sola pregunta, SI otorga (fuente agente_whatsapp), NO no se repite, revocado/queja/bandera apagada nunca preguntan.
--   E. RLS de lectura, ausencia de escritura directa y metricas (recompra, control, bajas, respuesta).
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; los alias con sufijo deberia_ser_N marcan el entero esperado (un solo count(*) por escenario).
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
  ('00000000-0000-0000-0000-0000000e4601', 'restaurantes', 'React Org A', 'react-a'),
  ('00000000-0000-0000-0000-0000000e4602', 'restaurantes', 'React Org B (ajena)', 'react-b')
on conflict do nothing;
insert into core.property (id, organization_id, name) values ('00000000-0000-0000-0000-0000000e46a1', '00000000-0000-0000-0000-0000000e4601', 'Sucursal A1'), ('00000000-0000-0000-0000-0000000e46b1', '00000000-0000-0000-0000-0000000e4602', 'Sucursal B1') on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug) values ('00000000-0000-0000-0000-0000000e46a1', '00000000-0000-0000-0000-0000000e4601', 'a1'), ('00000000-0000-0000-0000-0000000e46b1', '00000000-0000-0000-0000-0000000e4602', 'b1') on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e4615', 'acotado@react.example.com', 'Admin acotado a A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e4611', 'owner-a@react.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4614', 'owner-b@react.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e4615', '00000000-0000-0000-0000-0000000e4601', array['00000000-0000-0000-0000-0000000e46a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e4611', '00000000-0000-0000-0000-0000000e4601', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4614', '00000000-0000-0000-0000-0000000e4602', null, 'owner', 'owner')
on conflict do nothing;
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000e4601', 'pnid-react-a') on conflict do nothing;
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, estado) values ('00000000-0000-0000-0000-0000000e4601', 'restaurantes', 'marketing.reactivacion_favorito', 'reactivacion_favorito', 'aprobada') on conflict do nothing;

-- 6 clientes de A: 1,2,3 y 6 dormidos 15 dias; 4 dormido 30 dias (fuera de la ventana); 5 activo (10 dias). Cada uno con UN pedido (tacos de cochinita) en su ultimo_pedido.
insert into restaurantes.customers (id, organization_id, phone, name, order_count, last_order_at) values

  ('00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-0000000e4601', '+525554600001', 'Cliente 1', 1, now() - interval '15 days'),
  ('00000000-0000-0000-0000-00000c460002', '00000000-0000-0000-0000-0000000e4601', '+525554600002', 'Cliente 2', 1, now() - interval '15 days'),
  ('00000000-0000-0000-0000-00000c460003', '00000000-0000-0000-0000-0000000e4601', '+525554600003', 'Cliente 3', 1, now() - interval '15 days'),
  ('00000000-0000-0000-0000-00000c460004', '00000000-0000-0000-0000-0000000e4601', '+525554600004', 'Cliente 4', 1, now() - interval '30 days'),
  ('00000000-0000-0000-0000-00000c460005', '00000000-0000-0000-0000-0000000e4601', '+525554600005', 'Cliente 5', 1, now() - interval '10 days'),
  ('00000000-0000-0000-0000-00000c460006', '00000000-0000-0000-0000-0000000e4601', '+525554600006', 'Cliente 6', 1, now() - interval '15 days')
on conflict do nothing;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at)
select c.organization_id, '00000000-0000-0000-0000-0000000e46a1', c.id, c.name, c.phone, 180, 'entregado', '[{"id":"t1","name":"Tacos de cochinita","price":90,"quantity":2}]'::jsonb, 'whatsapp', c.last_order_at
  from restaurantes.customers c where c.organization_id = '00000000-0000-0000-0000-0000000e4601';

\echo '=== A1. universo opt-in = 0: 6 clientes dormidos y NINGUN consentimiento -> 0 candidatos ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
set local role authenticated;
select count(*) as universo_deberia_ser_0 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now());
rollback;

\echo '=== A2. solo 'otorgado' y dentro de la ventana 14-21 d: 1,2 otorgado; 3 revocado; 4 (30 d) y 5 (10 d) otorgados pero fuera de ventana -> 2 ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-00000c460002', '00000000-0000-0000-0000-00000c460004', '00000000-0000-0000-0000-00000c460005');
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460003');
set local role authenticated;
select count(*) as optin_deberia_ser_2 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now());
rollback;

\echo '=== A3. modo apagado (o sin configuracion) -> 0 aunque haya consentimiento ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'apagado', false);
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-00000c460002');
set local role authenticated;
select count(*) as apagado_deberia_ser_0 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now());
rollback;

\echo '=== A4. sin fila de configuracion -> 0 ==='
begin;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-00000c460002');
set local role authenticated;
select count(*) as sinconfig_deberia_ser_0 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now());
rollback;

\echo '=== A5. BAJA por telefono: el consentimiento se revoca y el cliente sale de los candidatos -> 1 ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-00000c460002');
set local role authenticated;
select restaurantes.marketing_revocar_por_telefono('00000000-0000-0000-0000-0000000e4601', '+525554600001');
select count(*) as baja_deberia_ser_1 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now());
rollback;

\echo '=== B1. favorito = renglon mas pedido del historial ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001');
set local role authenticated;
select count(*) as favorito_deberia_ser_1 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now()) where favorito = 'Tacos de cochinita' and dias_sin_pedir = 15;
rollback;

\echo '=== B2. interruptor por sucursal APAGADO por omision -> sucursal_activa false ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001');
set local role authenticated;
select count(*) as kill_deberia_ser_0 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now()) where sucursal_activa;
rollback;

\echo '=== B3. el owner prende la sucursal -> sucursal_activa true ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select restaurantes.reactivacion_set_sucursal('00000000-0000-0000-0000-0000000e46a1', true);
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select count(*) as prendida_deberia_ser_1 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now()) where sucursal_activa;
rollback;

\echo '=== B4. queja reciente (pedido en problema) se marca para excluir ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001');
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-0000000e46a1', '00000000-0000-0000-0000-00000c460001', 'x', 'x', 50, 'problema', '[]', 'whatsapp');
set local role authenticated;
select count(*) as queja_deberia_ser_1 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now()) where queja_reciente;
rollback;

\echo '=== B5. topes: un envio hace 3 dias cuenta en el intervalo de 14 d y en el mes ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'otorgado', 'checkout_web', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001');
insert into restaurantes.reactivacion_envio (organization_id, customer_id, property_id, dia, estado, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days');
set local role authenticated;
select count(*) as tope_deberia_ser_1 from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now()) where envios_en_intervalo = 1 and envios_en_mes >= 0;
rollback;

\echo '=== C1. registrar_envio es idempotente por cliente y dia: dos llamadas, una fila ==='
begin;
set local role authenticated;
select restaurantes.reactivacion_registrar_envio('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-0000000e46a1', current_date, 'simulado', 'reactivacion_favorito', 'Tacos de cochinita', null);
select restaurantes.reactivacion_registrar_envio('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-0000000e46a1', current_date, 'simulado', 'reactivacion_favorito', 'Tacos de cochinita', null);
reset role;
select count(*) as idempotente_deberia_ser_1 from restaurantes.reactivacion_envio where organization_id = '00000000-0000-0000-0000-0000000e4601';
rollback;

\echo '=== C2. RECHAZADO: cliente de otra organizacion al registrar -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.reactivacion_registrar_envio('00000000-0000-0000-0000-0000000e4602', '00000000-0000-0000-0000-00000c460001', null, current_date, 'simulado', null, null, null)$q$, '42501');
rollback;

\echo '=== C3. RECHAZADO: un usuario logueado no es el sistema (candidatos) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select public.t_esperar_error($q$select count(*) from restaurantes.reactivacion_candidatos('00000000-0000-0000-0000-0000000e4601', now())$q$, '42501');
rollback;

\echo '=== C4. RECHAZADO: pasar a 'real' sin ninguna simulacion previa -> P0001 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select public.t_esperar_error($q$select restaurantes.reactivacion_guardar_config('00000000-0000-0000-0000-0000000e4601', 'real', false, 14, 21, 14, 2, 10, 20, 50, 7, 'reactivacion_favorito', 'es_MX')$q$, 'P0001');
rollback;

\echo '=== C5. con una simulacion previa si se puede pasar a 'real' ==='
begin;
insert into restaurantes.reactivacion_corrida (organization_id, modo) values ('00000000-0000-0000-0000-0000000e4601', 'simulado');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select restaurantes.reactivacion_guardar_config('00000000-0000-0000-0000-0000000e4601', 'real', false, 14, 21, 14, 2, 10, 20, 50, 7, 'reactivacion_favorito', 'es_MX');
reset role;
select count(*) as real_deberia_ser_1 from restaurantes.reactivacion_config where organization_id = '00000000-0000-0000-0000-0000000e4601' and modo = 'real';
rollback;

\echo '=== C6. RECHAZADO: rangos invalidos (dias_max <= dias_min) -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select public.t_esperar_error($q$select restaurantes.reactivacion_guardar_config('00000000-0000-0000-0000-0000000e4601', 'simulado', false, 21, 14, 14, 2, 10, 20, 50, 7, null, 'es_MX')$q$, '22023');
rollback;

\echo '=== C7. RECHAZADO: owner de OTRA organizacion (cross-tenant) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4614', true);
select public.t_esperar_error($q$select restaurantes.reactivacion_guardar_config('00000000-0000-0000-0000-0000000e4601', 'simulado', false, 14, 21, 14, 2, 10, 20, 50, 7, null, 'es_MX')$q$, '42501');
rollback;

\echo '=== C8. RECHAZADO: admin acotado a una sucursal no administra la organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4615', true);
select public.t_esperar_error($q$select restaurantes.reactivacion_set_sucursal('00000000-0000-0000-0000-0000000e46a1', true)$q$, '42501');
rollback;

\echo '=== C9. RECHAZADO: anon no ejecuta nada -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.reactivacion_set_sucursal('00000000-0000-0000-0000-0000000e46a1', true)$q$, '42501');
rollback;

\echo '=== C10. RECHAZADO: sucursal ajena responde igual que inexistente -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4614', true);
select public.t_esperar_error($q$select restaurantes.reactivacion_set_sucursal('00000000-0000-0000-0000-0000000e46a1', true)$q$, '42501');
rollback;

\echo '=== D1. opt-in: habilitado y sin historial -> puede preguntar ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', true);
set local role authenticated;
select count(*) as puede_deberia_ser_1 from restaurantes.reactivacion_optin_contexto('00000000-0000-0000-0000-0000000e4601', '+525554600001', now()) where habilitado and puede_preguntar and not pregunta_abierta;
rollback;

\echo '=== D2. bandera apagada (por omision) -> nunca pregunta ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
set local role authenticated;
select count(*) as bandera_deberia_ser_0 from restaurantes.reactivacion_optin_contexto('00000000-0000-0000-0000-0000000e4601', '+525554600001', now()) where puede_preguntar;
rollback;

\echo '=== D3. una SOLA vez: tras marcar la pregunta ya no puede preguntar y queda abierta ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', true);
set local role authenticated;
select restaurantes.reactivacion_optin_marcar('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', now());
select count(*) as unavez_deberia_ser_1 from restaurantes.reactivacion_optin_contexto('00000000-0000-0000-0000-0000000e4601', '+525554600001', now()) where pregunta_abierta and not puede_preguntar;
rollback;

\echo '=== D4. un SI explicito a la pregunta abierta otorga el consentimiento (fuente agente_whatsapp) ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', true);
set local role authenticated;
select restaurantes.reactivacion_optin_marcar('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', now());
select restaurantes.reactivacion_optin_responder('00000000-0000-0000-0000-0000000e4601', '+525554600001', true, now());
reset role;
select count(*) as si_deberia_ser_1 from restaurantes.marketing_consentimiento where customer_id = '00000000-0000-0000-0000-00000c460001' and estado = 'otorgado' and fuente = 'agente_whatsapp';
rollback;

\echo '=== D5. un SI sin pregunta abierta NO es consentimiento ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', true);
set local role authenticated;
select restaurantes.reactivacion_optin_responder('00000000-0000-0000-0000-0000000e4601', '+525554600001', true, now());
reset role;
select count(*) as sinpregunta_deberia_ser_0 from restaurantes.marketing_consentimiento where customer_id = '00000000-0000-0000-0000-00000c460001';
rollback;

\echo '=== D6. un NO queda registrado, no otorga y no se vuelve a preguntar (90 d) ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', true);
set local role authenticated;
select restaurantes.reactivacion_optin_marcar('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', now());
select restaurantes.reactivacion_optin_responder('00000000-0000-0000-0000-0000000e4601', '+525554600001', false, now());
reset role;
select (select count(*) from restaurantes.marketing_consentimiento where customer_id = '00000000-0000-0000-0000-00000c460001') + (select count(*) from restaurantes.marketing_optin_pregunta where customer_id = '00000000-0000-0000-0000-00000c460001' and respuesta = 'no') + (select count(*) from restaurantes.reactivacion_optin_contexto('00000000-0000-0000-0000-0000000e4601', '+525554600001', now()) where puede_preguntar) as no_deberia_ser_1;
rollback;

\echo '=== D7. quien ya REVOCO (BAJA) o tiene queja reciente nunca recibe la pregunta ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', true);
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460001');
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-0000000e46a1', '00000000-0000-0000-0000-00000c460002', 'x', 'x', 50, 'problema', '[]', 'whatsapp');
set local role authenticated;
select count(*) as nuncapregunta_deberia_ser_0 from (select * from restaurantes.reactivacion_optin_contexto('00000000-0000-0000-0000-0000000e4601', '+525554600001', now()) union all select * from restaurantes.reactivacion_optin_contexto('00000000-0000-0000-0000-0000000e4601', '+525554600002', now())) x where puede_preguntar;
rollback;

\echo '=== D8. RECHAZADO: un usuario logueado no registra respuestas de opt-in -> 42501 ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select public.t_esperar_error($q$select restaurantes.reactivacion_optin_responder('00000000-0000-0000-0000-0000000e4601', '+525554600001', true, now())$q$, '42501');
rollback;

\echo '=== E1. RLS: el owner de A lee las corridas de A; el de B no ve ninguna de A ==='
begin;
insert into restaurantes.reactivacion_corrida (organization_id, modo) values ('00000000-0000-0000-0000-0000000e4601', 'simulado');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4614', true);
select count(*) as rls_deberia_ser_0 from restaurantes.reactivacion_corrida;
rollback;

\echo '=== E2. RLS: el owner de A si ve su corrida ==='
begin;
insert into restaurantes.reactivacion_corrida (organization_id, modo) values ('00000000-0000-0000-0000-0000000e4601', 'simulado');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select count(*) as rls_deberia_ser_1 from restaurantes.reactivacion_corrida;
rollback;

\echo '=== E3. RECHAZADO: ninguna escritura directa de authenticated -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select public.t_esperar_error($q$insert into restaurantes.reactivacion_envio (organization_id, customer_id, dia, estado) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', current_date, 'encolado')$q$, '42501');
rollback;

\echo '=== F1. metricas: enviados (2 encolados, no cuenta el control) ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.reactivacion_envio (organization_id, customer_id, property_id, dia, estado, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460003', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'control', now() - interval '3 days');
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-0000000e46a1', '00000000-0000-0000-0000-00000c460001', 'x', 'x', 200, 'entregado', '[]', 'whatsapp', now() - interval '2 days');
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages) values ('00000000-0000-0000-0000-0000000e4601', '+525554600001', jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'pedir', 'at', to_char((now() - interval '3 days' + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460002');
insert into restaurantes.marketing_consentimiento_evento (organization_id, customer_id, canal, estado, fuente, version_aviso, ocurrido_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() - interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select enviados as enviados_deberia_ser_2 from restaurantes.reactivacion_metricas('00000000-0000-0000-0000-0000000e4601', now() - interval '10 days', now() + interval '1 day');
rollback;

\echo '=== F2. metricas: recompraron en N dias (solo el cliente 1) ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.reactivacion_envio (organization_id, customer_id, property_id, dia, estado, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460003', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'control', now() - interval '3 days');
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-0000000e46a1', '00000000-0000-0000-0000-00000c460001', 'x', 'x', 200, 'entregado', '[]', 'whatsapp', now() - interval '2 days');
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages) values ('00000000-0000-0000-0000-0000000e4601', '+525554600001', jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'pedir', 'at', to_char((now() - interval '3 days' + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460002');
insert into restaurantes.marketing_consentimiento_evento (organization_id, customer_id, canal, estado, fuente, version_aviso, ocurrido_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() - interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select recompraron as recompra_deberia_ser_1 from restaurantes.reactivacion_metricas('00000000-0000-0000-0000-0000000e4601', now() - interval '10 days', now() + interval '1 day');
rollback;

\echo '=== F3. metricas: el grupo de control (sin recompra) se mide aparte ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.reactivacion_envio (organization_id, customer_id, property_id, dia, estado, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460003', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'control', now() - interval '3 days');
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-0000000e46a1', '00000000-0000-0000-0000-00000c460001', 'x', 'x', 200, 'entregado', '[]', 'whatsapp', now() - interval '2 days');
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages) values ('00000000-0000-0000-0000-0000000e4601', '+525554600001', jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'pedir', 'at', to_char((now() - interval '3 days' + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460002');
insert into restaurantes.marketing_consentimiento_evento (organization_id, customer_id, canal, estado, fuente, version_aviso, ocurrido_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() - interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select controles * 10 + recompraron_control as control_deberia_ser_10 from restaurantes.reactivacion_metricas('00000000-0000-0000-0000-0000000e4601', now() - interval '10 days', now() + interval '1 day');
rollback;

\echo '=== F4. metricas: respondieron dentro de 24 h (cliente 1) ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.reactivacion_envio (organization_id, customer_id, property_id, dia, estado, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460003', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'control', now() - interval '3 days');
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-0000000e46a1', '00000000-0000-0000-0000-00000c460001', 'x', 'x', 200, 'entregado', '[]', 'whatsapp', now() - interval '2 days');
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages) values ('00000000-0000-0000-0000-0000000e4601', '+525554600001', jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'pedir', 'at', to_char((now() - interval '3 days' + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460002');
insert into restaurantes.marketing_consentimiento_evento (organization_id, customer_id, canal, estado, fuente, version_aviso, ocurrido_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() - interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select respondieron as respondieron_deberia_ser_1 from restaurantes.reactivacion_metricas('00000000-0000-0000-0000-0000000e4601', now() - interval '10 days', now() + interval '1 day');
rollback;

\echo '=== F5. metricas: bajas dentro de la ventana (cliente 2) ==='
begin;
insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional) values ('00000000-0000-0000-0000-0000000e4601', 'simulado', false);
insert into restaurantes.reactivacion_envio (organization_id, customer_id, property_id, dia, estado, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460001', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'encolado', now() - interval '3 days'), ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460003', '00000000-0000-0000-0000-0000000e46a1', (now() - interval '3 days')::date, 'control', now() - interval '3 days');
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-0000000e46a1', '00000000-0000-0000-0000-00000c460001', 'x', 'x', 200, 'entregado', '[]', 'whatsapp', now() - interval '2 days');
insert into restaurantes.whatsapp_conversations (organization_id, phone, messages) values ('00000000-0000-0000-0000-0000000e4601', '+525554600001', jsonb_build_array(jsonb_build_object('role', 'user', 'content', 'pedir', 'at', to_char((now() - interval '3 days' + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at) select organization_id, id, 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() from restaurantes.customers where id in ('00000000-0000-0000-0000-00000c460002');
insert into restaurantes.marketing_consentimiento_evento (organization_id, customer_id, canal, estado, fuente, version_aviso, ocurrido_at) values ('00000000-0000-0000-0000-0000000e4601', '00000000-0000-0000-0000-00000c460002', 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() - interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4611', true);
select bajas as bajas_deberia_ser_1 from restaurantes.reactivacion_metricas('00000000-0000-0000-0000-0000000e4601', now() - interval '10 days', now() + interval '1 day');
rollback;

\echo '=== F6. RECHAZADO: metricas ajenas (cross-tenant) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4614', true);
select public.t_esperar_error($q$select * from restaurantes.reactivacion_metricas('00000000-0000-0000-0000-0000000e4601', now() - interval '10 days', now())$q$, '42501');
rollback;

