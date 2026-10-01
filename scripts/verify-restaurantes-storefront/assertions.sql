-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-restaurantes/migrations/032_storefront_rastreo_publico.sql
-- (rastreo publico de un pedido por token, sin datos personales).
--
--   A. storefront_order_tracking (solo-sistema): devuelve el estado y los renglones del pedido de SU
--      organizacion; el mismo id con OTRA organizacion da NULL (cross-tenant); id inexistente da NULL.
--   B. Sin datos personales: la respuesta NO contiene nombre, telefono, direccion, correo ni notas.
--   C. Rechazos: un usuario autenticado (auth.uid() no nulo) y anon no pueden ejecutarla.
--   D. El SELECT directo de la tabla sigue cerrado para la sesion de sistema (la funcion no abrio
--      ninguna policy nueva) y para anon.
--   E. base SIN migrar: 42883 recuperado con SAVEPOINT real (lo que hace runWithSavepointFallback).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail`
-- marca el que debe terminar en ERROR; `..._deberia_ser_N` el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0a01', 'restaurantes', 'Storefront Org A', 'storefront-org-a'),
  ('00000000-0000-0000-0000-0000000d0a02', 'restaurantes', 'Storefront Org B', 'storefront-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000d0b01', '00000000-0000-0000-0000-0000000d0a01', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000d0b03', '00000000-0000-0000-0000-0000000d0a02', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0c01', 'storefront-owner-a@example.com', 'Owner A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0c01', '00000000-0000-0000-0000-0000000d0a01', null, 'owner', 'owner')
on conflict do nothing;

-- Pedido a domicilio con datos personales (fixture directo, superusuario) y pedido para recoger.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, customer_address, branch, total, status, items, source, notes, payment_method)
values
  ('00000000-0000-0000-0000-0000000d0e01', '00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01',
   'Nombre Secreto', '9991234567', 'Calle Secreta 123', 'Sucursal A1', 250.50, 'preparando',
   '[{"id":"p1","name":"Tacos de pastor","price":50,"quantity":2,"tortilla":"maiz"},{"id":"p2","name":"Agua","price":30.5,"quantity":1}]'::jsonb,
   'web', E'Complementos incluidos: salsa verde.\nCanal: domicilio.', 'efectivo'),
  ('00000000-0000-0000-0000-0000000d0e02', '00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01',
   'Otro Cliente', '9997654321', null, 'Sucursal A1', 100, 'pending',
   '[{"id":"p1","name":"Tacos de pastor","price":50,"quantity":2}]'::jsonb,
   'web', E'Canal: recoger en sucursal.', 'tarjeta')
on conflict do nothing;

\echo ''
\echo '=== A) storefront_order_tracking (solo-sistema) ==='
\echo ''

\echo '--- 1. sesion de sistema con el id y la organizacion correctos: devuelve el estado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0e01')->>'status' = 'preparando')::int as estado_correcto_deberia_ser_1;
rollback;

\echo '--- 2. el MISMO pedido pedido con OTRA organizacion: NULL (cross-tenant) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a02', '00000000-0000-0000-0000-0000000d0e01') is null)::int as cross_tenant_nulo_deberia_ser_1;
rollback;

\echo '--- 3. pedido inexistente y ids nulos: NULL ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0eff') is null
        and restaurantes.storefront_order_tracking(null, null) is null)::int as inexistente_nulo_deberia_ser_1;
rollback;

\echo '--- 4. el canal se deduce de las notas: domicilio y recoger ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select ((restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0e01')->>'canal') = 'domicilio'
        and (restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0e02')->>'canal') = 'recoger')::int as canales_deberia_ser_1;
rollback;

\echo '--- 5. devuelve los renglones con nombre y cantidad ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (jsonb_array_length(restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0e01')->'items') = 2)::int as renglones_deberia_ser_1;
rollback;

\echo ''
\echo '=== B) sin datos personales ==='
\echo ''

\echo '--- 6. la respuesta no contiene nombre, telefono, direccion ni notas del cliente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0e01')::text !~* '(Nombre Secreto|9991234567|Calle Secreta|customer_|Complementos incluidos)')::int as sin_pii_deberia_ser_1;
rollback;

\echo '--- 7. las unicas llaves de la respuesta son las acotadas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (array(select jsonb_object_keys(restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0e01')) order by 1)
        = array['branch','canal','created_at','items','payment_method','status','total'])::int as llaves_acotadas_deberia_ser_1;
rollback;

\echo ''
\echo '=== C) rechazos ==='
\echo ''

\echo '--- 8. un usuario autenticado (auth.uid() no nulo), aunque sea owner de la organizacion: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0e01') as should_fail;
rollback;

\echo '--- 9. anon no tiene EXECUTE: RECHAZADO ---'
begin;
set local role anon;
select restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0e01') as should_fail;
rollback;

\echo ''
\echo '=== D) la tabla sigue cerrada ==='
\echo ''

\echo '--- 10. la sesion de sistema NO puede leer restaurantes.orders directamente (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.orders;
rollback;

\echo '--- 11. anon no puede leer restaurantes.orders: RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.orders;
rollback;

\echo '--- 12. el staff owner de la organizacion sigue viendo SUS pedidos por RLS (la funcion no cambio eso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select (count(*) = 2)::int as pedidos_del_staff_deberia_ser_1 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000d0a01';
rollback;

\echo ''
\echo '=== E) base SIN migrar: 42883 recuperado con SAVEPOINT real ==='
\echo ''

\echo '--- 13. sin la funcion (42883) un SAVEPOINT + ROLLBACK TO SAVEPOINT deja la transaccion usable ---'
begin;
drop function restaurantes.storefront_order_tracking(uuid, uuid);
savepoint sp_storefront_rastreo;
do $$
declare
  v_state text;
begin
  begin
    perform restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01'::uuid, '00000000-0000-0000-0000-0000000d0e01'::uuid);
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_storefront_rastreo;
release savepoint sp_storefront_rastreo;
select 1 as siguiente_consulta_del_request_deberia_ser_1;
rollback;

\echo '--- 14. SIN el SAVEPOINT, el mismo 42883 deja la transaccion abortada (25P02): la razon del helper ---'
begin;
drop function restaurantes.storefront_order_tracking(uuid, uuid);
select restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0e01');
select 1 as should_fail;
rollback;
