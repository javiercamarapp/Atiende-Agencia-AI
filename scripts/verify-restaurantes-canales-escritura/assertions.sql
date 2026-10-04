-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-restaurantes/migrations/045_sistema_escritura_clientes_avisos_y_eventos.sql
-- (P0 de la cuenta real de PM: la sesion de sistema no podia crear clientes, direcciones ni avisos de contacto).
--
-- ROL Y SESION EXACTOS DE PRODUCCION: `set local role authenticated` + `request.jwt.claim.sub = ''` (auth.uid() NULL),
-- que es lo que abre `ManagedPostgresEngine.withAppSession({ userId: null })` para el webhook de WhatsApp, las
-- herramientas de voz y el checkout web (ver packages/db/src/managed-postgres-engine.ts). Las funciones se invocan con
-- las MISMAS sentencias que el repositorio de produccion (PostgresRestaurantesRepository).
--
--   A. upsert_customer: cliente nuevo, cliente existente (no pisa el nombre), mismo telefono en otra organizacion
--      (cliente distinto), organizacion de otro vertical, telefono vacio, staff autenticado, anon, y el INSERT/UPDATE
--      directo sigue denegado (no se amplio ningun GRANT de tabla).
--   B. add_customer_address_if_new: primera direccion predeterminada, idempotente, cliente de OTRA organizacion
--      rechazado (cross-tenant), staff, anon, INSERT directo denegado.
--   C. create_callback_request: aviso creado (lo ve el staff de SU organizacion y no el de otra), sucursal de otra
--      organizacion, origen invalido, nombre vacio, staff, anon, INSERT directo denegado.
--   D. mark_whatsapp_inbound_failed: marca solo `processing` de SU organizacion, no degrada `processed`, staff, anon,
--      UPDATE directo denegado.
--   E. Pedido de punta a punta por CADA canal (whatsapp, voice, web) con cliente nuevo y con cliente existente,
--      domicilio, aviso y conversacion: cliente -> direccion -> create_order_idempotent -> whatsapp_append_turn ->
--      aviso, todo con el rol y la sesion de produccion.
--   F. base SIN migrar: sin las funciones (42883) un SAVEPOINT recupera la transaccion (lo que hace runWithSavepointFallback).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail` marca el que debe
-- terminar en ERROR; `..._deberia_ser_N` el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0a01', 'restaurantes', 'Canales Org A', 'canales-org-a'),
  ('00000000-0000-0000-0000-0000000d0a02', 'restaurantes', 'Canales Org B', 'canales-org-b'),
  ('00000000-0000-0000-0000-0000000d0a03', 'citas', 'Canales Org C (otro vertical)', 'canales-org-c')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000d0b01', '00000000-0000-0000-0000-0000000d0a01', 'restaurantes', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000d0b02', '00000000-0000-0000-0000-0000000d0a02', 'restaurantes', 'Sucursal B1'),
  ('00000000-0000-0000-0000-0000000d0b03', '00000000-0000-0000-0000-0000000d0a03', 'citas', 'Sucursal C1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0c01', 'canales-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0c02', 'canales-owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0c01', '00000000-0000-0000-0000-0000000d0a01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000d0c02', '00000000-0000-0000-0000-0000000d0a02', null, 'owner', 'owner')
on conflict do nothing;

-- Cliente existente de la Org A (con direccion) y de la Org B; mensaje de WhatsApp en curso de cada organizacion.
insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('00000000-0000-0000-0000-0000000d0d01', '00000000-0000-0000-0000-0000000d0a01', '9990000001', 'Cliente Existente A', 2),
  ('00000000-0000-0000-0000-0000000d0d02', '00000000-0000-0000-0000-0000000d0a02', '9990000002', 'Cliente Existente B', 1)
on conflict do nothing;
insert into restaurantes.customer_addresses (customer_id, address, is_default) values
  ('00000000-0000-0000-0000-0000000d0d01', 'Calle 1 #100', true)
on conflict do nothing;
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, status) values
  ('wamid.canales-processing', '00000000-0000-0000-0000-0000000d0a01', repeat('a', 64), 'processing'),
  ('wamid.canales-processed', '00000000-0000-0000-0000-0000000d0a01', repeat('b', 64), 'processed')
on conflict do nothing;

\echo ''
\echo '=== A) upsert_customer (sesion de sistema: rol authenticated, auth.uid() NULL) ==='
\echo ''

\echo '--- 1. cliente NUEVO: se crea y devuelve su id, organizacion, telefono y nombre ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (r->>'id' is not null and r->>'organization_id' = '00000000-0000-0000-0000-0000000d0a01' and r->>'phone' = '9991110001' and r->>'name' = 'Ana Nueva' and (r->>'order_count')::int = 0)::int as cliente_nuevo_deberia_ser_1
from (select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9991110001', 'Ana Nueva') as r) s;
rollback;

\echo '--- 2. cliente EXISTENTE: misma fila, nunca sobreescribe el nombre ya conocido ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (a->>'id' = '00000000-0000-0000-0000-0000000d0d01' and a->>'name' = 'Cliente Existente A' and (a->>'order_count')::int = 2)::int as cliente_existente_deberia_ser_1
from (select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9990000001', 'Otro Nombre') as a) s;
rollback;

\echo '--- 3. el MISMO telefono en otra organizacion es OTRO cliente (cross-tenant): 2 filas distintas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9991110002', 'Misma Persona');
select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a02', '9991110002', 'Misma Persona');
reset role;
select count(distinct id)::int as dos_clientes_distintos_deberia_ser_2 from restaurantes.customers where phone = '9991110002';
rollback;

\echo '--- 4. dos llamadas seguidas con el mismo telefono nuevo: una sola fila (atomico, sin carrera) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9991110003', 'Carrera 1');
select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9991110003', 'Carrera 2');
reset role;
select count(*)::int as una_sola_fila_deberia_ser_1 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000d0a01' and phone = '9991110003' and name = 'Carrera 1';
rollback;

\echo '--- 5. staff autenticado (owner de la Org A): rechazado, la funcion es solo-sistema ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9991110004', 'Staff') as should_fail;
rollback;

\echo '--- 6. anon: sin EXECUTE ---'
begin;
set local role anon;
select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9991110005', 'Anon') as should_fail;
rollback;

\echo '--- 7. organizacion de OTRO vertical (citas): rechazada, no se crea cliente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a03', '9991110006', 'Otro Vertical') as should_fail;
rollback;

\echo '--- 8. telefono vacio: rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '   ', 'Sin Telefono') as should_fail;
rollback;

\echo '--- 9. INSERT directo en customers con el rol de produccion: SIGUE denegado (no se amplio ningun GRANT) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into restaurantes.customers (organization_id, phone, name) values ('00000000-0000-0000-0000-0000000d0a01', '9991110007', 'Directo') returning id as should_fail;
rollback;

\echo '--- 10. UPDATE directo en customers con el rol de produccion: SIGUE denegado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
update restaurantes.customers set name = 'Directo' where id = '00000000-0000-0000-0000-0000000d0d01' returning id as should_fail;
rollback;

\echo ''
\echo '=== B) add_customer_address_if_new ==='
\echo ''

\echo '--- 11. cliente sin direcciones: la primera queda predeterminada; la segunda no; repetir no duplica ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a02', '00000000-0000-0000-0000-0000000d0d02', 'Calle B 1');
select restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a02', '00000000-0000-0000-0000-0000000d0d02', 'Calle B 2');
select restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a02', '00000000-0000-0000-0000-0000000d0d02', 'Calle B 1');
reset role;
select (count(*) = 2 and count(*) filter (where is_default) = 1 and bool_or(is_default and address = 'Calle B 1'))::int as direcciones_deberia_ser_1
from restaurantes.customer_addresses where customer_id = '00000000-0000-0000-0000-0000000d0d02';
rollback;

\echo '--- 12. cliente de OTRA organizacion (cross-tenant): rechazado y no inserta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a02', '00000000-0000-0000-0000-0000000d0d01', 'Calle Intrusa 9') as should_fail;
rollback;

\echo '--- 13. staff autenticado: rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0d01', 'Calle Staff 1') as should_fail;
rollback;

\echo '--- 14. anon: sin EXECUTE ---'
begin;
set local role anon;
select restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0d01', 'Calle Anon 1') as should_fail;
rollback;

\echo '--- 15. direccion vacia: rechazada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0d01', '') as should_fail;
rollback;

\echo '--- 16. INSERT directo en customer_addresses con el rol de produccion: SIGUE denegado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into restaurantes.customer_addresses (customer_id, address) values ('00000000-0000-0000-0000-0000000d0d01', 'Directa 1') returning id as should_fail;
rollback;

\echo ''
\echo '=== C) create_callback_request ==='
\echo ''

\echo '--- 17. aviso creado por la sesion de sistema; el staff de SU organizacion lo ve y el de otra NO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana Prueba', '+529991110010', 'queja', 'Me falto una coca', 'whatsapp');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select count(*)::int as staff_propio_ve_1_deberia_ser_1 from restaurantes.callback_requests where customer_phone = '+529991110010';
rollback;

\echo '--- 18. el owner de OTRA organizacion NO ve ese aviso (cross-tenant, RLS de lectura) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana Prueba', '+529991110011', 'queja', null, 'voice');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c02', true);
select count(*)::int as staff_ajeno_ve_0_deberia_ser_0 from restaurantes.callback_requests where customer_phone = '+529991110011';
rollback;

\echo '--- 19. sin sucursal (property_id NULL): permitido ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (r->>'id' is not null and (r->>'resolved')::boolean = false)::int as aviso_sin_sucursal_deberia_ser_1 from (select restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', null, 'Ana', '+529991110012', null, null, 'web') as r) s;
rollback;

\echo '--- 20. sucursal de OTRA organizacion: rechazada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b02', 'Ana', '+529991110013', null, null, 'voice') as should_fail;
rollback;

\echo '--- 21. organizacion de otro vertical: rechazada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a03', '00000000-0000-0000-0000-0000000d0b03', 'Ana', '+529991110014', null, null, 'voice') as should_fail;
rollback;

\echo '--- 22. origen fuera del catalogo (CHECK): rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '+529991110015', null, null, 'fax') as should_fail;
rollback;

\echo '--- 23. nombre vacio: rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', '  ', '+529991110016', null, null, 'voice') as should_fail;
rollback;

\echo '--- 24. staff autenticado: rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '+529991110017', null, null, 'admin') as should_fail;
rollback;

\echo '--- 25. anon: sin EXECUTE ---'
begin;
set local role anon;
select restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '+529991110018', null, null, 'web') as should_fail;
rollback;

\echo '--- 26. INSERT directo en callback_requests con el rol de produccion: SIGUE denegado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into restaurantes.callback_requests (organization_id, customer_name, customer_phone, source) values ('00000000-0000-0000-0000-0000000d0a01', 'Directo', '+529991110019', 'voice') returning id as should_fail;
rollback;

\echo ''
\echo '=== D) mark_whatsapp_inbound_failed ==='
\echo ''

\echo '--- 27. mensaje en `processing` de SU organizacion: queda `failed` con la clase de error ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.mark_whatsapp_inbound_failed('00000000-0000-0000-0000-0000000d0a01', 'wamid.canales-processing', 'ConversationBusy');
reset role;
select count(*)::int as marcado_failed_deberia_ser_1 from restaurantes.whatsapp_inbound_events where message_id = 'wamid.canales-processing' and status = 'failed' and last_error_class = 'ConversationBusy';
rollback;

\echo '--- 28. un mensaje ya `processed` NO se degrada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.mark_whatsapp_inbound_failed('00000000-0000-0000-0000-0000000d0a01', 'wamid.canales-processed', 'ConversationBusy');
reset role;
select count(*)::int as processed_intacto_deberia_ser_1 from restaurantes.whatsapp_inbound_events where message_id = 'wamid.canales-processed' and status = 'processed';
rollback;

\echo '--- 29. otra organizacion NO puede marcar el mensaje ajeno (cross-tenant): sigue `processing` ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.mark_whatsapp_inbound_failed('00000000-0000-0000-0000-0000000d0a02', 'wamid.canales-processing', 'ConversationBusy');
reset role;
select count(*)::int as ajeno_intacto_deberia_ser_1 from restaurantes.whatsapp_inbound_events where message_id = 'wamid.canales-processing' and status = 'processing';
rollback;

\echo '--- 30. staff autenticado: rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select restaurantes.mark_whatsapp_inbound_failed('00000000-0000-0000-0000-0000000d0a01', 'wamid.canales-processing', 'X') as should_fail;
rollback;

\echo '--- 31. anon: sin EXECUTE ---'
begin;
set local role anon;
select restaurantes.mark_whatsapp_inbound_failed('00000000-0000-0000-0000-0000000d0a01', 'wamid.canales-processing', 'X') as should_fail;
rollback;

\echo '--- 32. UPDATE directo en whatsapp_inbound_events con el rol de produccion: SIGUE denegado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
update restaurantes.whatsapp_inbound_events set status = 'failed' where message_id = 'wamid.canales-processing' returning message_id as should_fail;
rollback;

\echo ''
\echo '=== E) pedido de punta a punta por CADA canal (rol authenticated, auth.uid() NULL) ==='
\echo ''

\echo '--- 33. canal whatsapp: cliente nuevo + cliente existente, domicilio, aviso y conversacion de punta a punta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  v_cliente jsonb;
  v_pedido jsonb;
  v_conv jsonb;
  v_aviso jsonb;
begin
  -- Cliente NUEVO a domicilio: cliente -> direccion -> pedido -> conversacion -> aviso.
  v_cliente := restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9992220001', 'Cliente whatsapp');
  perform restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', (v_cliente->>'id')::uuid, 'Calle whatsapp 123');
  v_pedido := restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', '00000000-0000-0000-0000-0000000d0a01', 'property_id', '00000000-0000-0000-0000-0000000d0b01', 'customer_id', v_cliente->>'id',
      'customer_name', 'Cliente whatsapp', 'customer_phone', '9992220001', 'customer_address', 'Calle whatsapp 123',
      'branch', 'Sucursal A1', 'total', 126, 'source', 'whatsapp', 'payment_method', 'efectivo',
      'items', jsonb_build_array(jsonb_build_object('id', 'p1', 'name', 'Taco', 'price', 42, 'quantity', 3))
    ), '1111111111111111111111111111111111111111111111111111111111111111', null);
  if v_pedido->>'id' is null or v_pedido->>'customer_id' <> v_cliente->>'id' then
    raise exception 'el pedido no quedo ligado al cliente nuevo';
  end if;
  if 'whatsapp' = 'whatsapp' then
    v_conv := restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000d0a01', '+529992220001', '[{"role":"user","content":"hola"}]'::jsonb, 'completed', (v_pedido->>'id')::uuid, '00000000-0000-0000-0000-0000000d0b01');
    if jsonb_array_length(v_conv) < 1 then raise exception 'la conversacion no se guardo'; end if;
  end if;
  v_aviso := restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Cliente whatsapp', '9992220001', 'queja', 'sin PII', 'whatsapp');
  if v_aviso->>'id' is null then raise exception 'el aviso no se creo'; end if;

  -- Cliente EXISTENTE (de la Org A): mismo cliente, direccion nueva, segundo pedido distinto.
  v_cliente := restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9990000001', 'Cliente Existente A');
  if v_cliente->>'id' <> '00000000-0000-0000-0000-0000000d0d01' then raise exception 'el cliente existente no se reutilizo'; end if;
  perform restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', (v_cliente->>'id')::uuid, 'Calle Nueva whatsapp 7');
  v_pedido := restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', '00000000-0000-0000-0000-0000000d0a01', 'property_id', '00000000-0000-0000-0000-0000000d0b01', 'customer_id', v_cliente->>'id',
      'customer_name', 'Cliente Existente A', 'customer_phone', '9990000001', 'customer_address', 'Calle Nueva whatsapp 7',
      'branch', 'Sucursal A1', 'total', 84, 'source', 'whatsapp', 'payment_method', 'tarjeta',
      'items', jsonb_build_array(jsonb_build_object('id', 'p1', 'name', 'Taco', 'price', 42, 'quantity', 2))
    ), 'f111111111111111111111111111111111111111111111111111111111111111', null);
  if v_pedido->>'id' is null then raise exception 'el pedido del cliente existente no se creo'; end if;
end $$;
reset role;
select (
  (select count(*) from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000d0a01' and source = 'whatsapp' and customer_phone = '9992220001') = 1
  and (select count(*) from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000d0a01' and source = 'whatsapp' and customer_phone = '9990000001') = 1
  and (select order_count from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000d0a01' and phone = '9992220001') = 1
  and (select count(*) from restaurantes.callback_requests where organization_id = '00000000-0000-0000-0000-0000000d0a01' and customer_phone = '9992220001') = 1
)::int as canal_whatsapp_extremo_a_extremo_deberia_ser_1;
rollback;

\echo '--- 34. canal voice: cliente nuevo + cliente existente, domicilio, aviso y conversacion de punta a punta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  v_cliente jsonb;
  v_pedido jsonb;
  v_conv jsonb;
  v_aviso jsonb;
begin
  -- Cliente NUEVO a domicilio: cliente -> direccion -> pedido -> conversacion -> aviso.
  v_cliente := restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9992220002', 'Cliente voice');
  perform restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', (v_cliente->>'id')::uuid, 'Calle voice 123');
  v_pedido := restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', '00000000-0000-0000-0000-0000000d0a01', 'property_id', '00000000-0000-0000-0000-0000000d0b01', 'customer_id', v_cliente->>'id',
      'customer_name', 'Cliente voice', 'customer_phone', '9992220002', 'customer_address', 'Calle voice 123',
      'branch', 'Sucursal A1', 'total', 126, 'source', 'voice', 'payment_method', 'efectivo',
      'items', jsonb_build_array(jsonb_build_object('id', 'p1', 'name', 'Taco', 'price', 42, 'quantity', 3))
    ), '2222222222222222222222222222222222222222222222222222222222222222', null);
  if v_pedido->>'id' is null or v_pedido->>'customer_id' <> v_cliente->>'id' then
    raise exception 'el pedido no quedo ligado al cliente nuevo';
  end if;
  if 'voice' = 'whatsapp' then
    v_conv := restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000d0a01', '+529992220002', '[{"role":"user","content":"hola"}]'::jsonb, 'completed', (v_pedido->>'id')::uuid, '00000000-0000-0000-0000-0000000d0b01');
    if jsonb_array_length(v_conv) < 1 then raise exception 'la conversacion no se guardo'; end if;
  end if;
  v_aviso := restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Cliente voice', '9992220002', 'queja', 'sin PII', 'voice');
  if v_aviso->>'id' is null then raise exception 'el aviso no se creo'; end if;

  -- Cliente EXISTENTE (de la Org A): mismo cliente, direccion nueva, segundo pedido distinto.
  v_cliente := restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9990000001', 'Cliente Existente A');
  if v_cliente->>'id' <> '00000000-0000-0000-0000-0000000d0d01' then raise exception 'el cliente existente no se reutilizo'; end if;
  perform restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', (v_cliente->>'id')::uuid, 'Calle Nueva voice 7');
  v_pedido := restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', '00000000-0000-0000-0000-0000000d0a01', 'property_id', '00000000-0000-0000-0000-0000000d0b01', 'customer_id', v_cliente->>'id',
      'customer_name', 'Cliente Existente A', 'customer_phone', '9990000001', 'customer_address', 'Calle Nueva voice 7',
      'branch', 'Sucursal A1', 'total', 84, 'source', 'voice', 'payment_method', 'tarjeta',
      'items', jsonb_build_array(jsonb_build_object('id', 'p1', 'name', 'Taco', 'price', 42, 'quantity', 2))
    ), 'f222222222222222222222222222222222222222222222222222222222222222', null);
  if v_pedido->>'id' is null then raise exception 'el pedido del cliente existente no se creo'; end if;
end $$;
reset role;
select (
  (select count(*) from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000d0a01' and source = 'voice' and customer_phone = '9992220002') = 1
  and (select count(*) from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000d0a01' and source = 'voice' and customer_phone = '9990000001') = 1
  and (select order_count from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000d0a01' and phone = '9992220002') = 1
  and (select count(*) from restaurantes.callback_requests where organization_id = '00000000-0000-0000-0000-0000000d0a01' and customer_phone = '9992220002') = 1
)::int as canal_voice_extremo_a_extremo_deberia_ser_1;
rollback;

\echo '--- 35. canal web: cliente nuevo + cliente existente, domicilio, aviso y conversacion de punta a punta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  v_cliente jsonb;
  v_pedido jsonb;
  v_conv jsonb;
  v_aviso jsonb;
begin
  -- Cliente NUEVO a domicilio: cliente -> direccion -> pedido -> conversacion -> aviso.
  v_cliente := restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9992220003', 'Cliente web');
  perform restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', (v_cliente->>'id')::uuid, 'Calle web 123');
  v_pedido := restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', '00000000-0000-0000-0000-0000000d0a01', 'property_id', '00000000-0000-0000-0000-0000000d0b01', 'customer_id', v_cliente->>'id',
      'customer_name', 'Cliente web', 'customer_phone', '9992220003', 'customer_address', 'Calle web 123',
      'branch', 'Sucursal A1', 'total', 126, 'source', 'web', 'payment_method', 'efectivo',
      'items', jsonb_build_array(jsonb_build_object('id', 'p1', 'name', 'Taco', 'price', 42, 'quantity', 3))
    ), '3333333333333333333333333333333333333333333333333333333333333333', null);
  if v_pedido->>'id' is null or v_pedido->>'customer_id' <> v_cliente->>'id' then
    raise exception 'el pedido no quedo ligado al cliente nuevo';
  end if;
  if 'web' = 'whatsapp' then
    v_conv := restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-0000000d0a01', '+529992220003', '[{"role":"user","content":"hola"}]'::jsonb, 'completed', (v_pedido->>'id')::uuid, '00000000-0000-0000-0000-0000000d0b01');
    if jsonb_array_length(v_conv) < 1 then raise exception 'la conversacion no se guardo'; end if;
  end if;
  v_aviso := restaurantes.create_callback_request('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Cliente web', '9992220003', 'queja', 'sin PII', 'web');
  if v_aviso->>'id' is null then raise exception 'el aviso no se creo'; end if;

  -- Cliente EXISTENTE (de la Org A): mismo cliente, direccion nueva, segundo pedido distinto.
  v_cliente := restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9990000001', 'Cliente Existente A');
  if v_cliente->>'id' <> '00000000-0000-0000-0000-0000000d0d01' then raise exception 'el cliente existente no se reutilizo'; end if;
  perform restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', (v_cliente->>'id')::uuid, 'Calle Nueva web 7');
  v_pedido := restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', '00000000-0000-0000-0000-0000000d0a01', 'property_id', '00000000-0000-0000-0000-0000000d0b01', 'customer_id', v_cliente->>'id',
      'customer_name', 'Cliente Existente A', 'customer_phone', '9990000001', 'customer_address', 'Calle Nueva web 7',
      'branch', 'Sucursal A1', 'total', 84, 'source', 'web', 'payment_method', 'tarjeta',
      'items', jsonb_build_array(jsonb_build_object('id', 'p1', 'name', 'Taco', 'price', 42, 'quantity', 2))
    ), 'f333333333333333333333333333333333333333333333333333333333333333', null);
  if v_pedido->>'id' is null then raise exception 'el pedido del cliente existente no se creo'; end if;
end $$;
reset role;
select (
  (select count(*) from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000d0a01' and source = 'web' and customer_phone = '9992220003') = 1
  and (select count(*) from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000d0a01' and source = 'web' and customer_phone = '9990000001') = 1
  and (select order_count from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000d0a01' and phone = '9992220003') = 1
  and (select count(*) from restaurantes.callback_requests where organization_id = '00000000-0000-0000-0000-0000000d0a01' and customer_phone = '9992220003') = 1
)::int as canal_web_extremo_a_extremo_deberia_ser_1;
rollback;

\echo '--- 36. cross-tenant de punta a punta: el pedido de la Org A con un cliente de la Org B se rechaza al ligar la direccion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.add_customer_address_if_new('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0d02', 'Intrusa') as should_fail;
rollback;

\echo ''
\echo '=== F) base SIN migrar: 42883 recuperable con SAVEPOINT (lo que hace runWithSavepointFallback) ==='
\echo ''

\echo '--- 37. sin upsert_customer (42883) un SAVEPOINT + ROLLBACK TO SAVEPOINT deja la transaccion usable ---'
begin;
drop function restaurantes.upsert_customer(uuid, text, text);
savepoint sp_canales_escritura;
do $$
declare
  v_state text;
begin
  begin
    perform restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01'::uuid, '9993330001', 'Sin Migrar');
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_canales_escritura;
release savepoint sp_canales_escritura;
select 1 as siguiente_consulta_del_request_deberia_ser_1;
rollback;

\echo '--- 38. SIN el SAVEPOINT, el mismo 42883 deja la transaccion abortada (25P02): la razon del helper ---'
begin;
drop function restaurantes.upsert_customer(uuid, text, text);
select restaurantes.upsert_customer('00000000-0000-0000-0000-0000000d0a01', '9993330002', 'Sin Migrar');
select 1 as should_fail;
rollback;
