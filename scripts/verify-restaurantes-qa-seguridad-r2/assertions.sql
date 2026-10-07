-- QA restaurantes ronda 2, lote seguridad -- escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/075_seguridad_r2_alcance_y_compensaciones.sql.
--
--   P. promotions (R2-seguridad-02): un usuario de otra organizacion y anon no leen codigos; la sesion de sistema resuelve solo activos.
--   N. solicitudes de compensacion (R2-seguridad-03): staff no crea ni aprueba dinero; owner si, con tope y una vez por pedido.
--   E. core.emit_notification (R2-seguridad-04): una sesion de usuario de restaurantes no emite criticos ni ajenos ni agota el cupo del sistema.
--   F. cliente_marcar_pedido_falso (R2-seguridad-05): alcance por sucursal y cross-tenant.
--   X. cliente_exportar_arco (R2-seguridad-06): entrega WhatsApp, contactos, voz, pedidos completos y ARCO; declara lo excluido; solo owner/admin.
--   G. storefront_marca_sello sin EXECUTE para anon (R2-seguridad-08).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias con sufijo deberia_ser_N marca el valor
-- esperado; un escenario sin alias debe terminar sin error (t_esperar_error exige el SQLSTATE exacto).
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
  ('00000000-0000-0000-0000-0000000e7001', 'restaurantes', 'R2 Org A', 'r2seg-org-a'),
  ('00000000-0000-0000-0000-0000000e7002', 'restaurantes', 'R2 Org B (ajena)', 'r2seg-org-b'),
  ('00000000-0000-0000-0000-0000000e7003', 'hoteles', 'R2 Hotel H', 'r2seg-hotel-h')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', 'restaurantes', 'A1', 'active'),
  ('00000000-0000-0000-0000-0000000e70a2', '00000000-0000-0000-0000-0000000e7001', 'restaurantes', 'A2', 'active'),
  ('00000000-0000-0000-0000-0000000e70b1', '00000000-0000-0000-0000-0000000e7002', 'restaurantes', 'B1', 'active'),
  ('00000000-0000-0000-0000-0000000e70f1', '00000000-0000-0000-0000-0000000e7003', 'hoteles', 'H1', 'active')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7001', 'a1', 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e70a2', '00000000-0000-0000-0000-0000000e7001', 'a2', 'America/Mexico_City')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e7011', 'r2seg-owner-a@qa.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e7012', 'r2seg-repartidor-a1@qa.example.com', 'Repartidor A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e7013', 'r2seg-staff-a1@qa.example.com', 'Staff A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e7021', 'r2seg-owner-b@qa.example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-0000000e7031', 'r2seg-owner-h@qa.example.com', 'Owner H', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e7011', '00000000-0000-0000-0000-0000000e7001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e7012', '00000000-0000-0000-0000-0000000e7001', array['00000000-0000-0000-0000-0000000e70a1']::uuid[], 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e7013', '00000000-0000-0000-0000-0000000e7001', array['00000000-0000-0000-0000-0000000e70a1']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e7021', '00000000-0000-0000-0000-0000000e7002', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e7031', '00000000-0000-0000-0000-0000000e7003', null, 'owner', 'owner')
on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values
  ('00000000-0000-0000-0000-0000000e7c01', '00000000-0000-0000-0000-0000000e7001', '+529990000001', 'Cliente Real A'),
  ('00000000-0000-0000-0000-0000000e7c02', '00000000-0000-0000-0000-0000000e7001', '+529990000002', 'Otro Cliente A')
on conflict do nothing;
insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, total, items, source, status, notes, call_transcript) values
  ('00000000-0000-0000-0000-0000000e7a11', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7c01', 'Cliente Real A', '+529990000001', 'Calle 1 #2', 900, '[{"name":"Tacos","price":300,"quantity":3}]'::jsonb, 'whatsapp', 'entregado', 'sin cebolla', null),
  ('00000000-0000-0000-0000-0000000e7a21', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a2', '00000000-0000-0000-0000-0000000e7c01', 'Cliente Real A', '+529990000001', null, 480, '[]'::jsonb, 'web', 'pending', null, null),
  ('00000000-0000-0000-0000-0000000e7a31', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', null, 'Cliente Real A', '999 000 0001', null, 120, '[]'::jsonb, 'voice', 'entregado', null, 'Hola, quiero unos tacos'),
  ('00000000-0000-0000-0000-0000000e7a41', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7c02', 'Otro Cliente A', '+529990000002', null, 2500, '[{"name":"Taco","price":100,"quantity":25}]'::jsonb, 'whatsapp', 'entregado', null, null),
  ('00000000-0000-0000-0000-0000000e7a51', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', '00000000-0000-0000-0000-0000000e7c02', 'Otro Cliente A', '+529990000002', null, 200, '[{"name":"Taco","price":100,"quantity":2}]'::jsonb, 'whatsapp', 'entregado', null, null)
on conflict do nothing;
insert into restaurantes.order_privacy_consent (organization_id, order_id, notice_version, channel) values ('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7a11', 'v-r2', 'web');
insert into restaurantes.promotions (id, organization_id, code, name, type, value, max_uses, is_active) values
  ('00000000-0000-0000-0000-0000000e7b01', '00000000-0000-0000-0000-0000000e7001', 'GRACIAS-QAR2CODE', 'Compensacion de un solo uso', 'percentage', 20, 1, true),
  ('00000000-0000-0000-0000-0000000e7b02', '00000000-0000-0000-0000-0000000e7002', 'QAR2PRIVADOB', 'Codigo privado de B', 'percentage', 50, null, true),
  ('00000000-0000-0000-0000-0000000e7b03', '00000000-0000-0000-0000-0000000e7001', 'QAR2INACTIVA', 'Inactiva', 'percentage', 10, null, false)
on conflict do nothing;
insert into restaurantes.solicitud_aprobacion (id, organization_id, property_id, tipo, order_id, detalle) values
  ('00000000-0000-0000-0000-0000000e7d11', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'compensacion', '00000000-0000-0000-0000-0000000e7a11', '{"subtipo":"faltante"}'::jsonb),
  ('00000000-0000-0000-0000-0000000e7d13', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'compensacion', '00000000-0000-0000-0000-0000000e7a41', '{"subtipo":"faltante"}'::jsonb),
  ('00000000-0000-0000-0000-0000000e7d14', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'compensacion', '00000000-0000-0000-0000-0000000e7a51', '{"subtipo":"frio"}'::jsonb);
insert into restaurantes.whatsapp_conversations (organization_id, phone, property_id, messages) values
  ('00000000-0000-0000-0000-0000000e7001', '+52 999 000 0001', '00000000-0000-0000-0000-0000000e70a1', '[{"role":"user","content":"hola quiero tacos"}]'::jsonb),
  ('00000000-0000-0000-0000-0000000e7001', '9990000002', '00000000-0000-0000-0000-0000000e70a1', '[{"role":"user","content":"conversacion de otra persona"}]'::jsonb);
insert into restaurantes.callback_requests (organization_id, property_id, customer_name, customer_phone, reason, message, source) values
  ('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Cliente Real A', '9990000001', 'queja', 'llamenme por favor', 'whatsapp'),
  ('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'Otro Cliente A', '9990000002', 'queja', 'mensaje de otra persona', 'whatsapp');
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash) values
  ('00000000-0000-0000-0000-0000000e7e01', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'r2seg-call-1', 'llamada', 'gemini-3.8-live', encode(sha256(convert_to('529990000001', 'UTF8')), 'hex')),
  ('00000000-0000-0000-0000-0000000e7e02', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'r2seg-call-2', 'llamada', 'gemini-3.8-live', encode(sha256(convert_to('529990000002', 'UTF8')), 'hex'));
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values
  ('00000000-0000-0000-0000-0000000e7e01', '00000000-0000-0000-0000-0000000e7001', 0, 'cliente', 'quiero tacos al pastor'),
  ('00000000-0000-0000-0000-0000000e7e01', '00000000-0000-0000-0000-0000000e7001', 1, 'agente', 'claro, en que sucursal'),
  ('00000000-0000-0000-0000-0000000e7e02', '00000000-0000-0000-0000-0000000e7001', 0, 'cliente', 'turno de otra persona');
insert into restaurantes.data_rights_requests (id, organization_id, customer_phone, right_type, channel, status, requested_at, confirmed_at, response_due_at, execution_due_at, resolved_at)
values ('00000000-0000-0000-0000-0000000e7e11', '00000000-0000-0000-0000-0000000e7001', '+529990000001', 'acceso', 'whatsapp', 'resuelta', now(), now(), now() + interval '20 days', now() + interval '35 days', now());
insert into restaurantes.data_rights_events (organization_id, request_id, actor_kind, event, to_status) values ('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7e11', 'sistema', 'registrada', 'recibida');

\echo '=== P1. owner de un HOTEL (otra organizacion y vertical) no ve los codigos de compensacion de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7031', true);
select count(*) as codigos_ajenos_deberia_ser_0 from restaurantes.promotions where code like 'GRACIAS-%';
rollback;

\echo '=== P1b. owner de B no ve los codigos de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7021', true);
select count(*) as codigos_de_a_deberia_ser_0 from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000e7001';
rollback;

\echo '=== P2. anon no tiene SELECT sobre promociones -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select code from restaurantes.promotions$q$, '42501');
rollback;

\echo '=== P3. la sesion de sistema (sin usuario) resuelve un codigo activo por su texto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_resuelve_deberia_ser_1 from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000e7001' and code = 'GRACIAS-QAR2CODE' and is_active;
rollback;

\echo '=== P3b. la sesion de sistema no ve promociones inactivas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_inactivas_deberia_ser_0 from restaurantes.promotions where is_active = false;
rollback;

\echo '=== P4. el owner de A sigue viendo las promociones de su organizacion (incluida la inactiva) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select count(*) as owner_ve_las_suyas_deberia_ser_2 from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000e7001';
rollback;

\echo '=== N1. un staff no crea una compensacion para si mismo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'compensacion', '00000000-0000-0000-0000-0000000e7a11', '{}'::jsonb)$q$, '42501');
rollback;

\echo '=== N1b. un staff si crea una solicitud de cancelacion con su alcance ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select creada::int as staff_crea_cancelacion_deberia_ser_1 from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'cancelacion', '00000000-0000-0000-0000-0000000e7a11', '{}'::jsonb);
rollback;

\echo '=== N1c. el sistema (agente) crea la compensacion del cliente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select creada::int as sistema_crea_compensacion_deberia_ser_1 from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'compensacion', '00000000-0000-0000-0000-0000000e7a31', '{}'::jsonb);
rollback;

\echo '=== N1d. un owner crea la compensacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select creada::int as owner_crea_compensacion_deberia_ser_1 from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'compensacion', '00000000-0000-0000-0000-0000000e7a31', '{}'::jsonb);
rollback;

\echo '=== N2. un staff no repone producto sin costo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d11', 'reponer_producto', null, null, array[0])$q$, '42501');
rollback;

\echo '=== N2b. un staff no emite un codigo de descuento -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d11', 'descuento_proximo', null, 20, null)$q$, '42501');
rollback;

\echo '=== N2c. un staff si cierra una queja sin compensacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select aplicado::int as staff_sin_compensacion_deberia_ser_1 from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d14', 'sin_compensacion', null, null, null);
rollback;

\echo '=== N3. un owner repone producto: crea el pedido de $0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select (reposicion_order_id is not null)::int as owner_repone_deberia_ser_1 from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d11', 'reponer_producto', null, null, array[0]);
rollback;

\echo '=== N3b. un owner emite un codigo de descuento GRACIAS ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select (codigo_descuento like 'GRACIAS-%')::int as owner_descuento_deberia_ser_1 from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d11', 'descuento_proximo', null, 10, null);
rollback;

\echo '=== N4. una sola reposicion sin costo por pedido original -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d11', 'reponer_producto', null, null, array[0]);
reset role;
insert into restaurantes.solicitud_aprobacion (id, organization_id, property_id, tipo, order_id, detalle) values ('00000000-0000-0000-0000-0000000e7d12', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'compensacion', '00000000-0000-0000-0000-0000000e7a11', '{"subtipo":"tarde"}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d12', 'reponer_producto', null, null, array[0])$q$, '22023');
rollback;

\echo '=== N5. un solo codigo de compensacion por pedido original -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d11', 'descuento_proximo', null, 10, null);
reset role;
insert into restaurantes.solicitud_aprobacion (id, organization_id, property_id, tipo, order_id, detalle) values ('00000000-0000-0000-0000-0000000e7d12', '00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e70a1', 'compensacion', '00000000-0000-0000-0000-0000000e7a11', '{"subtipo":"tarde"}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d12', 'descuento_proximo', null, 10, null)$q$, '22023');
rollback;

\echo '=== N6. tope de 20 unidades por reposicion sin costo -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d13', 'reponer_producto', null, null, array[0])$q$, '22023');
rollback;

\echo '=== N7. cross-tenant: el owner de B no resuelve una solicitud de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7021', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d11', 'sin_compensacion', null, null, null)$q$, '42501');
rollback;

\echo '=== N8. anon no ejecuta solicitud_resolver -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7d11', 'sin_compensacion', null, null, null)$q$, '42501');
rollback;

\echo '=== E1. un repartidor no emite un aviso critico con texto libre -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7012', true);
select public.t_esperar_error($q$select core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.pedido_grande', 'pedidos', 'critica', 'Titulo', null, '/r2', null, null, 'restaurantes.pedido_grande:x', null, null)$q$, '42501');
rollback;

\echo '=== E1b. un staff no emite un aviso critico -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select public.t_esperar_error($q$select core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.pedido.nuevo', 'pedidos', 'critica', 'Titulo', null, '/r2', null, null, 'restaurantes.pedido.nuevo:x', null, null)$q$, '42501');
rollback;

\echo '=== E1c. un repartidor no emite avisos que no sean la incidencia de repartidor -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7012', true);
select public.t_esperar_error($q$select core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.pedido.nuevo', 'pedidos', 'info', 'Titulo', null, '/r2', null, null, 'restaurantes.pedido.nuevo:x', null, null)$q$, '42501');
rollback;

\echo '=== E1d. un staff no emite un aviso de otro vertical -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select public.t_esperar_error($q$select core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'hoteles.ticket.sla_vencido', 'pedidos', 'info', 'Titulo', null, '/r2', null, null, 'hoteles.ticket.sla_vencido:x', null, null)$q$, '42501');
rollback;

\echo '=== E1e. un staff no se adelanta a una clave de dedupe de otro tipo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select public.t_esperar_error($q$select core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.pedido.nuevo', 'pedidos', 'info', 'Titulo', null, '/r2', null, null, 'restaurantes.aprobacion.pedido_grande:abc', null, null)$q$, '42501');
rollback;

\echo '=== E2. el repartidor si emite la incidencia de repartidor ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7012', true);
select core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.pedido.incidencia_repartidor', 'pedidos', 'atencion', 'Titulo', null, '/r2', null, null, 'restaurantes.pedido.incidencia_repartidor:o1', null, null) as incidencia_deberia_ser_1;
rollback;

\echo '=== E2b. el staff si emite avisos de su vertical ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.pedido.nuevo', 'pedidos', 'info', 'Titulo', null, '/r2', null, null, 'restaurantes.pedido.nuevo:o2', null, null) as staff_emite_deberia_ser_1;
rollback;

\echo '=== E2c. la sesion de sistema emite un aviso critico ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.aprobacion.vencida', 'pedidos', 'critica', 'Titulo', null, '/r2', null, null, 'restaurantes.aprobacion.vencida:s1', null, null) as sistema_critico_deberia_ser_1;
rollback;

\echo '=== E2d. otras verticales no cambian: el owner de un hotel emite un aviso critico ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7031', true);
select core.emit_notification('00000000-0000-0000-0000-0000000e7003', null, 'hoteles.ticket.sla_vencido', 'pedidos', 'critica', 'Titulo', null, '/r2', null, null, 'hoteles.ticket.sla_vencido:t1', null, null) as hotel_sin_cambio_deberia_ser_1;
rollback;

\echo '=== E3. el relleno de un usuario no agota el cupo del sistema: el aviso real del sistema llega ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
do $$ declare i int; begin
  for i in 1..100 loop
    perform core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.pedido.nuevo', 'pedidos', 'info', 'x', null, null, null, null, 'restaurantes.pedido.nuevo:relleno-' || i, null, null);
  end loop;
end $$;
select set_config('request.jwt.claim.sub', '', true);
select core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.aprobacion.pedido_grande', 'aprobaciones', 'atencion', 'Pedido grande por aprobar', null, '/r2', null, null, 'restaurantes.aprobacion.pedido_grande:real', null, null) as aviso_del_sistema_deberia_ser_1;
rollback;

\echo '=== E3b. el relleno de un usuario queda en el tope de 30 por hora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
do $$ declare i int; begin
  for i in 1..100 loop
    perform core.emit_notification('00000000-0000-0000-0000-0000000e7001', null, 'restaurantes.pedido.nuevo', 'pedidos', 'info', 'x', null, null, null, null, 'restaurantes.pedido.nuevo:relleno-' || i, null, null);
  end loop;
end $$;
reset role;
select count(*) as avisos_del_relleno_deberia_ser_30 from core.notification where organization_id = '00000000-0000-0000-0000-0000000e7001' and staff_user_id = '00000000-0000-0000-0000-0000000e7011';
rollback;

\echo '=== F1. staff acotado a A1 no marca como falso un pedido de A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select public.t_esperar_error($q$select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7a21', true)$q$, '42501');
rollback;

\echo '=== F2. staff acotado a A1 si marca un pedido de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7a11', true)::int as staff_marca_su_sucursal_deberia_ser_1;
rollback;

\echo '=== F3. el owner sin acotar marca un pedido de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7a21', true)::int as owner_marca_cualquiera_deberia_ser_1;
rollback;

\echo '=== F4. el repartidor no marca pedidos como falsos -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7012', true);
select public.t_esperar_error($q$select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7a11', true)$q$, '42501');
rollback;

\echo '=== F5. cross-tenant: el owner de B no marca un pedido de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7021', true);
select public.t_esperar_error($q$select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7a11', true)$q$, '42501');
rollback;

\echo '=== X1. el export ARCO trae la conversacion de WhatsApp del titular (y no la de otra persona) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select jsonb_array_length(j -> 'conversaciones_whatsapp') as conversaciones_deberia_ser_1 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X1b. el export ARCO trae el texto de los mensajes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select (j -> 'conversaciones_whatsapp' -> 0 -> 'mensajes' -> 0 ->> 'content' = 'hola quiero tacos')::int as mensaje_deberia_ser_1 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X2. el export ARCO trae su solicitud de contacto (y no la de otra persona) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select jsonb_array_length(j -> 'solicitudes_de_contacto') as contactos_deberia_ser_1 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X3. el export ARCO trae la llamada de voz del titular con sus 2 turnos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select jsonb_array_length(j -> 'llamadas_de_voz' -> 0 -> 'turnos') as turnos_deberia_ser_2 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X3b. el export ARCO trae una sola llamada (no la de otra persona) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select jsonb_array_length(j -> 'llamadas_de_voz') as llamadas_deberia_ser_1 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X4. el export ARCO trae los pedidos del titular, incluido el de solo telefono ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select jsonb_array_length(j -> 'pedidos') as pedidos_deberia_ser_3 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X4b. el export ARCO trae la transcripcion de la llamada del pedido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select (select count(*) from jsonb_array_elements(j -> 'pedidos') p where p ->> 'transcripcion_de_llamada' = 'Hola, quiero unos tacos')::int as transcripcion_deberia_ser_1 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X4c. el export ARCO trae la direccion y el consentimiento del pedido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select (select count(*) from jsonb_array_elements(j -> 'pedidos') p where p ->> 'direccion_de_entrega' = 'Calle 1 #2' and p -> 'consentimiento_de_aviso' ->> 'version_del_aviso' = 'v-r2')::int as direccion_y_consentimiento_deberia_ser_1 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X5. el export ARCO trae su historial de solicitudes ARCO con sus eventos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select jsonb_array_length(j -> 'solicitudes_arco' -> 0 -> 'historial') as historial_arco_deberia_ser_1 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X6. el export ARCO declara lo que no incluye ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7011', true);
select jsonb_array_length(j -> 'no_incluido') as no_incluido_deberia_ser_3 from (select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01') as j) e;
rollback;

\echo '=== X7. un staff no exporta la ficha ARCO -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7013', true);
select public.t_esperar_error($q$select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01')$q$, '42501');
rollback;

\echo '=== X8. cross-tenant: el owner de B no exporta un cliente de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7021', true);
select public.t_esperar_error($q$select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01')$q$, '42501');
rollback;

\echo '=== X9. anon no ejecuta el export ARCO -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000e7001', '00000000-0000-0000-0000-0000000e7c01')$q$, '42501');
rollback;

\echo '=== G1. storefront_marca_sello no es ejecutable por anon ==='
begin;
select has_function_privilege('anon', 'restaurantes.storefront_marca_sello()', 'execute')::int as anon_ejecuta_deberia_ser_0;
rollback;

\echo '=== G2. storefront_marca_sello no es ejecutable por PUBLIC ==='
begin;
select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname = 'storefront_marca_sello' and p.proacl is null)::int as public_ejecuta_deberia_ser_0;
rollback;
