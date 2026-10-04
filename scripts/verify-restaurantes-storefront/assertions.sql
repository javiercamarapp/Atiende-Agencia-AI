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

-- =====================================================================================================================
-- R-38 / R-43 -- packages/domain-restaurantes/migrations/042_storefront_marca.sql
--   F. marca publica (restaurantes.storefront_marca): lectura de sistema / staff de la organizacion; escritura solo owner/admin;
--      cross-tenant; anon; CHECK de enlaces; columnas de sello no escribibles; sin DELETE.
--   G. solicitud de evento del storefront: el INSERT directo del sistema sobre callback_requests esta cerrado (hallazgo); la funcion
--      solo-sistema callback_registrar registra la solicitud con motivo 'evento' y canal 'web'; el staff de SU organizacion la ve (y el
--      de otra no); un usuario con sesion, anon, una sucursal ajena, un canal invalido o datos fuera de rango son rechazados.
-- =====================================================================================================================
\echo ''
\echo '=== F) marca publica del storefront (042) ==='
\echo ''

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0c02', 'storefront-staff-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0c03', 'storefront-owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0c02', '00000000-0000-0000-0000-0000000d0a01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000d0c03', '00000000-0000-0000-0000-0000000d0a02', null, 'owner', 'owner')
on conflict do nothing;
insert into restaurantes.storefront_marca (organization_id, titular, eslogan, portada_url, instagram_url) values
  ('00000000-0000-0000-0000-0000000d0a01', 'Marca A', 'Desde 1980', 'https://cdn.example.com/a.jpg', 'https://instagram.com/marca_a')
on conflict do nothing;

\echo '--- 15. la sesion de sistema (auth.uid() nulo, la del storefront publico) lee la marca de la organizacion: 1 fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as marca_visible_deberia_ser_1 from restaurantes.storefront_marca where organization_id = '00000000-0000-0000-0000-0000000d0a01';
rollback;

\echo '--- 16. el staff de OTRA organizacion no ve la marca ajena: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c03', true);
select count(*) as marca_ajena_deberia_ser_0 from restaurantes.storefront_marca where organization_id = '00000000-0000-0000-0000-0000000d0a01';
rollback;

\echo '--- 17. anon no lee la marca: RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.storefront_marca;
rollback;

\echo '--- 18. el staff NO puede leer la columna de sello updated_by (sin GRANT de columna): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select updated_by as should_fail from restaurantes.storefront_marca;
rollback;

\echo '--- 19. owner de la organizacion edita su marca (UPDATE): 1 fila y el trigger sella updated_by con SU id ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.storefront_marca set titular = 'Marca A editada' where organization_id = '00000000-0000-0000-0000-0000000d0a01';
reset role;
select (titular = 'Marca A editada' and updated_by = '00000000-0000-0000-0000-0000000d0c01')::int as editada_y_sellada_deberia_ser_1 from restaurantes.storefront_marca where organization_id = '00000000-0000-0000-0000-0000000d0a01';
rollback;

\echo '--- 20. el staff (no owner/admin) intenta editar la marca: 0 filas afectadas (RLS) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c02', true);
with u as (update restaurantes.storefront_marca set titular = 'Hackeada' where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1)
select count(*) as filas_afectadas_deberia_ser_0 from u;
rollback;

\echo '--- 21. el owner de OTRA organizacion intenta editar la marca ajena: 0 filas afectadas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c03', true);
with u as (update restaurantes.storefront_marca set titular = 'Hackeada' where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1)
select count(*) as filas_afectadas_deberia_ser_0 from u;
rollback;

\echo '--- 22. el owner de OTRA organizacion intenta CREAR la marca de la organizacion A: RECHAZADO (with check) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c03', true);
insert into restaurantes.storefront_marca (organization_id, titular) values ('00000000-0000-0000-0000-0000000d0a01', 'x') on conflict (organization_id) do update set titular = excluded.titular;
select 1 as should_fail;
rollback;

\echo '--- 23. owner B crea la marca de SU organizacion (INSERT): 1 fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c03', true);
insert into restaurantes.storefront_marca (organization_id, titular) values ('00000000-0000-0000-0000-0000000d0a02', 'Marca B') returning organization_id;
rollback;

\echo '--- 24. el staff (no owner/admin) intenta CREAR su marca: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c02', true);
insert into restaurantes.storefront_marca (organization_id, titular) values ('00000000-0000-0000-0000-0000000d0a02', 'x');
select 1 as should_fail;
rollback;

\echo '--- 25. mover la marca a otra organizacion (UPDATE de organization_id): RECHAZADO (sin GRANT de esa columna) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.storefront_marca set organization_id = '00000000-0000-0000-0000-0000000d0a02' where organization_id = '00000000-0000-0000-0000-0000000d0a01';
select 1 as should_fail;
rollback;

\echo '--- 26. falsificar el sello (UPDATE de updated_by): RECHAZADO (sin GRANT de esa columna) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.storefront_marca set updated_by = '00000000-0000-0000-0000-0000000d0c02' where organization_id = '00000000-0000-0000-0000-0000000d0a01';
select 1 as should_fail;
rollback;

\echo '--- 27. nadie borra la marca (sin DELETE): RECHAZADO para el owner ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
delete from restaurantes.storefront_marca where organization_id = '00000000-0000-0000-0000-0000000d0a01';
select 1 as should_fail;
rollback;

\echo '--- 28. CHECK: portada con http (no https) RECHAZADA ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.storefront_marca set portada_url = 'http://cdn.example.com/a.jpg' where organization_id = '00000000-0000-0000-0000-0000000d0a01';
select 1 as should_fail;
rollback;

\echo '--- 29. CHECK: javascript: como logo RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.storefront_marca set logo_url = 'javascript:alert(1)' where organization_id = '00000000-0000-0000-0000-0000000d0a01';
select 1 as should_fail;
rollback;

\echo '--- 30. CHECK: una red apuntando a otro dominio RECHAZADA ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.storefront_marca set instagram_url = 'https://evil.example.com/instagram.com/x' where organization_id = '00000000-0000-0000-0000-0000000d0a01';
select 1 as should_fail;
rollback;

\echo '--- 31. CHECK: titular de mas de 120 caracteres RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.storefront_marca set titular = repeat('x', 121) where organization_id = '00000000-0000-0000-0000-0000000d0a01';
select 1 as should_fail;
rollback;

\echo ''
\echo '=== G) solicitud de evento del storefront ==='
\echo ''

\echo '--- 32. HALLAZGO: el INSERT directo de la sesion de sistema (como authenticated) sobre callback_requests es RECHAZADO (sin GRANT de INSERT): por eso existe callback_registrar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into restaurantes.callback_requests (organization_id, property_id, customer_name, customer_phone, reason, source)
values ('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '9991234567', 'evento', 'web');
select 1 as should_fail;
rollback;

\echo '--- 33. la sesion de sistema registra una solicitud de evento por callback_registrar (reason evento, source web): 1 fila con los datos exactos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_devueltas_deberia_ser_1 from restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '9991234567', 'evento', E'Fecha del evento: 2026-11-15\nPersonas: 40', 'web');
rollback;

\echo '--- 34. la solicitud queda guardada con el motivo y el canal correctos y la organizacion/sucursal dadas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '9991234567', 'evento', 'm', 'web');
reset role;
select (count(*) = 1)::int as fila_correcta_deberia_ser_1 from restaurantes.callback_requests
 where organization_id = '00000000-0000-0000-0000-0000000d0a01' and property_id = '00000000-0000-0000-0000-0000000d0b01'
   and reason = 'evento' and source = 'web' and customer_phone = '9991234567' and resolved = false and status = 'nuevo';
rollback;

\echo '--- 35. el staff de la organizacion VE la solicitud por RLS; el staff de OTRA organizacion no (cross-tenant) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '9991234567', 'evento', 'm', 'web');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select (count(*) = 1)::int as staff_propio_ve_la_solicitud_deberia_ser_1 from restaurantes.callback_requests where reason = 'evento';
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '9991234567', 'evento', 'm', 'web');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c03', true);
select count(*) as staff_ajeno_no_ve_nada_deberia_ser_0 from restaurantes.callback_requests where reason = 'evento';
rollback;

\echo '--- 36. un usuario con sesion (auth.uid() no nulo), aunque sea owner de la organizacion, NO puede usar callback_registrar: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '9991234567', 'evento', 'm', 'web') as should_fail;
rollback;

\echo '--- 37. anon no tiene EXECUTE: RECHAZADO ---'
begin;
set local role anon;
select restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '9991234567', 'evento', 'm', 'web') as should_fail;
rollback;

\echo '--- 38. una sucursal de OTRA organizacion: RECHAZADA (sin sondeo cross-tenant) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b03', 'Ana', '9991234567', 'evento', 'm', 'web') as should_fail;
rollback;

\echo '--- 39. canal admin (es del staff, no del sistema) o canal inventado: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '9991234567', 'evento', 'm', 'admin') as should_fail;
rollback;

\echo '--- 40. datos fuera de rango (mensaje de mas de 2000 caracteres): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', '00000000-0000-0000-0000-0000000d0b01', 'Ana', '9991234567', 'evento', repeat('x', 2001), 'web') as should_fail;
rollback;

\echo '--- 41. organizacion inexistente: RECHAZADA ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0aff', null, 'Ana', '9991234567', 'evento', 'm', 'web') as should_fail;
rollback;

\echo '--- 42. sin sucursal (null) es valido: 1 fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_devueltas_deberia_ser_1 from restaurantes.callback_registrar('00000000-0000-0000-0000-0000000d0a01', null, 'Ana', '9991234567', 'evento', 'm', 'voice');
rollback;
