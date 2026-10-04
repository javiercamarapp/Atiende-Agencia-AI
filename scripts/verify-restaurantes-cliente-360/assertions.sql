-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/044_cliente_360_memoria_domicilios_gustos.sql: memoria del cliente (Cliente 360).
--
--   A. SISTEMA (auth.uid() NULL, rol authenticated): cliente_memoria lee la memoria por (organizacion, telefono) aunque las
--      policies de customers/orders exijan membresia; cliente_registrar_pedido cierra el ciclo (domicilio + gustos) y es
--      IDEMPOTENTE por pedido; telefono de otra organizacion = sin memoria; categorias invalidas se ignoran.
--   B. Autorizacion: un usuario autenticado no puede llamar las funciones de sistema; las de staff exigen rol owner/admin/staff
--      de LA organizacion (repartidor y otro tenant, 42501); anon sin EXECUTE; la politica solo la guarda owner/admin.
--   C. Staff: ficha completa, actualizar (fecha de nacimiento valida), domicilios (etiqueta, referencias, Maps https, sucursal de
--      la propia organizacion), gustos (agregar/descartar), pedido falso, exportacion ARCO y borrado de memoria.
--   D. Reincidencia: no_recogidos en la ventana (el viejo no cuenta) y pedidos falsos.
--   E. Tablas: gustos solo SELECT para gestores de su organizacion (aislamiento por tenant); el cierre y las escrituras directas
--      estan negados a authenticated; anon sin acceso.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el
-- que debe terminar en ERROR; los alias con sufijo deberia_ser_N marcan el valor esperado.
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
  ('00000000-0000-0000-0000-0000000c3601', 'restaurantes', 'Cliente360 Org A', 'c360-a'),
  ('00000000-0000-0000-0000-0000000c3602', 'restaurantes', 'Cliente360 Org B (ajena)', 'c360-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3601', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000c36b1', '00000000-0000-0000-0000-0000000c3602', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3601', 'a1'),
  ('00000000-0000-0000-0000-0000000c36b1', '00000000-0000-0000-0000-0000000c3602', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c3611', 'owner-a@c360.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000c3612', 'staff-a@c360.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000c3613', 'rep-a@c360.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000c3614', 'owner-b@c360.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c3611', '00000000-0000-0000-0000-0000000c3601', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c3612', '00000000-0000-0000-0000-0000000c3601', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000c3613', '00000000-0000-0000-0000-0000000c3601', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000c3614', '00000000-0000-0000-0000-0000000c3602', null, 'owner', 'owner')
on conflict do nothing;

-- Clientes: Ana (org A, 3 pedidos y dos no recogidos recientes + uno viejo), Beto (org B, mismo telefono que Ana en otra organizacion).
insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('00000000-0000-0000-0000-0000000c3621', '00000000-0000-0000-0000-0000000c3601', '5511110001', 'Ana', 3),
  ('00000000-0000-0000-0000-0000000c3622', '00000000-0000-0000-0000-0000000c3602', '5511110001', 'Beto', 1);

insert into restaurantes.customer_addresses (id, customer_id, label, address, is_default, last_used_at, times_used) values
  ('00000000-0000-0000-0000-0000000c3631', '00000000-0000-0000-0000-0000000c3621', 'casa', 'Calle Uno 10, Col. Centro', true, '2026-03-01 12:00:00+00', 2),
  ('00000000-0000-0000-0000-0000000c3632', '00000000-0000-0000-0000-0000000c3621', 'oficina', 'Av. Dos 20, Col. Norte', false, '2026-03-10 12:00:00+00', 1);

insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at, pedido_falso_at) values
  ('00000000-0000-0000-0000-0000000c3641', '00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3621', 'Ana', '5511110001', 150, 'entregado', '[{"id":"p1","name":"Orden de tacos","price":75,"quantity":2,"tortilla":"maiz"}]', 'whatsapp', now() - interval '10 days', null),
  ('00000000-0000-0000-0000-0000000c3642', '00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3621', 'Ana', '5511110001', 75, 'entregado', '[{"id":"p1","name":"Orden de tacos","price":75,"quantity":1,"tortilla":"maiz"}]', 'whatsapp', now() - interval '5 days', null),
  ('00000000-0000-0000-0000-0000000c3643', '00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3621', 'Ana', '5511110001', 90, 'cancelado', '[{"id":"p2","name":"Refresco","price":30,"quantity":3}]', 'whatsapp', now() - interval '4 days', null),
  ('00000000-0000-0000-0000-0000000c3644', '00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3621', 'Ana', '5511110001', 80, 'no_recogido', '[]', 'whatsapp', now() - interval '20 days', null),
  ('00000000-0000-0000-0000-0000000c3645', '00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3621', 'Ana', '5511110001', 80, 'no_recogido', '[]', 'whatsapp', now() - interval '30 days', null),
  ('00000000-0000-0000-0000-0000000c3646', '00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3621', 'Ana', '5511110001', 80, 'no_recogido', '[]', 'whatsapp', now() - interval '200 days', null),
  -- Pedido nuevo (sin cierre aplicado todavia) con el que se prueba cliente_registrar_pedido.
  ('00000000-0000-0000-0000-0000000c3647', '00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3621', 'Ana', '5511110001', 150, 'pending', '[]', 'whatsapp', now(), null),
  ('00000000-0000-0000-0000-0000000c3648', '00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c36a1', '00000000-0000-0000-0000-0000000c3621', 'Ana', '5511110001', 150, 'pending', '[]', 'whatsapp', now(), null),
  -- Pedido de la organizacion B (cliente Beto).
  ('00000000-0000-0000-0000-0000000c3649', '00000000-0000-0000-0000-0000000c3602', '00000000-0000-0000-0000-0000000c36b1', '00000000-0000-0000-0000-0000000c3622', 'Beto', '5511110001', 60, 'entregado', '[]', 'whatsapp', now() - interval '3 days', null);

-- Gusto previo de Ana (visto 2 veces) para las pruebas de aislamiento de tabla.
insert into restaurantes.customer_preferences (id, organization_id, customer_id, kind, value, source, times_seen) values
  ('00000000-0000-0000-0000-0000000c3651', '00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', 'tortilla', 'maiz', 'pedido', 2);

\echo '=== A1. sistema: cliente_memoria devuelve a Ana por telefono (2 entregados y 2 pendientes cuentan; cancelado y no recogidos no) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'orders') as pedidos_que_cuentan_deberia_ser_4;
rollback;

\echo '=== A2. sistema: el nombre es el de la organizacion A (no se mezcla con Beto de B) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'customer' ->> 'name' = 'Ana')::int as es_ana_deberia_ser_1;
rollback;

\echo '=== A3. sistema: telefono inexistente en la organizacion = sin memoria (null) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5599999999') is null)::int as sin_memoria_deberia_ser_1;
rollback;

\echo '=== A4. sistema: domicilios, el ultimo usado primero (oficina) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'addresses' -> 0 ->> 'label' = 'oficina')::int as primera_es_oficina_deberia_ser_1;
rollback;

\echo '=== A5. sistema: no recogidos dentro de la ventana de 90 dias = 2 (el de hace 200 dias no cuenta) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'confiabilidad' ->> 'no_recogidos_90d')::int as no_recogidos_deberia_ser_2;
rollback;

\echo '=== A6. sistema: umbral por omision 2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'confiabilidad' ->> 'umbral')::int as umbral_deberia_ser_2;
rollback;

\echo '=== A6b. sistema: la memoria trae la llave tier (calc_customer_tier corre con los privilegios del dueno, no bajo RLS) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') ? 'tier')::int as trae_llave_tier_deberia_ser_1;
rollback;

\echo '=== A7. autorizacion: un usuario autenticado NO puede llamar cliente_memoria (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select public.t_esperar_error($q$select restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001')$q$, '42501') as sin_error;
rollback;

\echo '=== A8. anon: sin EXECUTE de cliente_memoria (42501) ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001')$q$, '42501') as sin_error;
rollback;

\echo '=== A9. sistema: organizacion de otro vertical o inexistente = 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c36ff', '5511110001')$q$, '42501') as sin_error;
rollback;

\echo '=== B1. sistema: cliente_registrar_pedido aplica la primera vez ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select ((restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3647',
  '{"address":"Calle Uno 10, Col. Centro","label":"casa","access_notes":"porton verde","maps_url":"https://maps.example.com/x","colonia":"Centro","property_id":"00000000-0000-0000-0000-0000000c36a1"}'::jsonb,
  '[{"kind":"tortilla","value":"harina"},{"kind":"salsa","value":"salsa_verde"}]'::jsonb) ->> 'aplicado')::boolean)::int as aplicado_deberia_ser_1;
rollback;

\echo '=== B2. sistema: la segunda llamada con el MISMO pedido no cuenta nada (idempotente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3647', null, '[{"kind":"tortilla","value":"harina"}]'::jsonb);
select ((restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3647', null, '[{"kind":"tortilla","value":"harina"}]'::jsonb) ->> 'aplicado')::boolean)::int as segunda_vez_aplicado_deberia_ser_0;
rollback;

\echo '=== B3. sistema: dos pedidos distintos con la misma tortilla suman times_seen = 2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3647', null, '[{"kind":"tortilla","value":"harina"}]'::jsonb);
select restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3648', null, '[{"kind":"tortilla","value":"harina"}]'::jsonb);
select (p ->> 'times_seen')::int as harina_times_seen_deberia_ser_2
  from jsonb_array_elements(restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'preferences') p
 where p ->> 'value' = 'harina';
rollback;

\echo '=== B4. sistema: el domicilio ya guardado suma un uso y conserva etiqueta/referencias (times_used 2 -> 3) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3647', '{"address":"Calle Uno 10, Col. Centro","access_notes":"porton verde"}'::jsonb, '[]'::jsonb);
select (a ->> 'times_used')::int as times_used_deberia_ser_3
  from jsonb_array_elements(restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'addresses') a
 where a ->> 'label' = 'casa';
rollback;

\echo '=== B5. sistema: un link de Maps invalido (http) se ignora sin error y el domicilio se guarda ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3647', '{"address":"Calle Tres 30, Col. Sur","maps_url":"http://inseguro.example.com/x"}'::jsonb, '[]'::jsonb);
select count(*)::int as domicilios_deberia_ser_3
  from jsonb_array_elements(restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'addresses') a;
rollback;

\echo '=== B6. sistema: una categoria de gusto invalida se ignora (no se guarda) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3647', null, '[{"kind":"inventada","value":"x"},{"kind":"nota","value":""}]'::jsonb);
select count(*)::int as gustos_nuevos_deberia_ser_1
  from jsonb_array_elements(restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'preferences') p;
rollback;

\echo '=== B7. cross-tenant: registrar el pedido de la organizacion A declarando la B = 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3602', '00000000-0000-0000-0000-0000000c3647', null, '[]'::jsonb)$q$, '42501') as sin_error;
rollback;

\echo '=== B8. autorizacion: un usuario autenticado NO puede llamar cliente_registrar_pedido (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select public.t_esperar_error($q$select restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3647', null, '[]'::jsonb)$q$, '42501') as sin_error;
rollback;

\echo '=== B9. anon: sin EXECUTE de cliente_registrar_pedido (42501) ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.cliente_registrar_pedido('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3647', null, '[]'::jsonb)$q$, '42501') as sin_error;
rollback;

\echo '=== C1. staff (owner): la ficha trae los datos, 2 domicilios y 3 gustos/obs previos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select jsonb_array_length(restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'addresses') as domicilios_deberia_ser_2;
rollback;

\echo '=== C2. staff (rol staff) tambien lee la ficha ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select (restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'customer' ->> 'name' = 'Ana')::int as nombre_deberia_ser_1;
rollback;

\echo '=== C3. repartidor: ficha negada (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3613', true);
select public.t_esperar_error($q$select restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== C4. cross-tenant: owner de B no lee la ficha de A declarando A (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select public.t_esperar_error($q$select restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== C5. cross-tenant: owner de B pidiendo el cliente de A declarando B = null (no existe en su organizacion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select (restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3602', '00000000-0000-0000-0000-0000000c3621') is null)::int as ficha_ajena_null_deberia_ser_1;
rollback;

\echo '=== C6. anon: sin EXECUTE de cliente_ficha (42501) ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== C7. sistema (auth.uid() null) NO puede usar funciones de staff (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== C8. staff: actualizar nombre y fecha de nacimiento valida (15 de marzo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select restaurantes.cliente_actualizar('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', '{"name":"Ana Maria","fecha_nacimiento_dia":15,"fecha_nacimiento_mes":3,"staff_notes":"cliente frecuente"}'::jsonb);
select ((restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'customer' ->> 'fecha_nacimiento_mes')::int) as mes_deberia_ser_3;
rollback;

\echo '=== C9. staff: 31 de abril es una fecha imposible (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select public.t_esperar_error($q$select restaurantes.cliente_actualizar('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', '{"fecha_nacimiento_dia":31,"fecha_nacimiento_mes":4}'::jsonb)$q$, '23514') as sin_error;
rollback;

\echo '=== C10. staff: actualizar un cliente de otra organizacion (declarando la propia) = 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select public.t_esperar_error($q$select restaurantes.cliente_actualizar('00000000-0000-0000-0000-0000000c3602', '00000000-0000-0000-0000-0000000c3621', '{"name":"X"}'::jsonb)$q$, '42501') as sin_error;
rollback;

\echo '=== C11. staff: guardar un domicilio nuevo con etiqueta, referencias, Maps https y sucursal propia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select restaurantes.cliente_direccion_guardar('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', null,
  '{"address":"Calle Cuatro 40","label":"casa de mama","access_notes":"timbre 2","maps_url":"https://maps.example.com/y","colonia":"Oriente","property_id":"00000000-0000-0000-0000-0000000c36a1"}'::jsonb);
select jsonb_array_length(restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'addresses') as domicilios_deberia_ser_3;
rollback;

\echo '=== C12. staff: link de Maps http se rechaza (22023) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select public.t_esperar_error($q$select restaurantes.cliente_direccion_guardar('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', null, '{"address":"X","maps_url":"http://x.example.com"}'::jsonb)$q$, '22023') as sin_error;
rollback;

\echo '=== C13. staff: una sucursal de OTRA organizacion en el domicilio = 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select public.t_esperar_error($q$select restaurantes.cliente_direccion_guardar('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', null, '{"address":"X","property_id":"00000000-0000-0000-0000-0000000c36b1"}'::jsonb)$q$, '42501') as sin_error;
rollback;

\echo '=== C14. staff: borrar la predeterminada pasa la marca a la mas reciente (oficina) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select restaurantes.cliente_direccion_borrar('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', '00000000-0000-0000-0000-0000000c3631');
select (a ->> 'is_default')::boolean::int as oficina_ahora_predeterminada_deberia_ser_1
  from jsonb_array_elements(restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'addresses') a
 where a ->> 'label' = 'oficina';
rollback;

\echo '=== C15. staff: agregar un gusto y descartarlo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select restaurantes.cliente_preferencia_accion('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', 'descartar', '00000000-0000-0000-0000-0000000c3651', null, null);
select (p ->> 'status' = 'descartada')::int as maiz_descartado_deberia_ser_1
  from jsonb_array_elements(restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'preferences') p
 where p ->> 'value' = 'maiz';
rollback;

\echo '=== C16. staff: categoria de gusto invalida (22023) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select public.t_esperar_error($q$select restaurantes.cliente_preferencia_accion('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', 'agregar', null, 'inventada', 'x')$q$, '22023') as sin_error;
rollback;

\echo '=== C17. repartidor: no puede tocar gustos (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3613', true);
select public.t_esperar_error($q$select restaurantes.cliente_preferencia_accion('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', 'agregar', null, 'nota', 'sin cebolla')$q$, '42501') as sin_error;
rollback;

\echo '=== D1. staff: marcar un pedido como falso sube pedidos_falsos a 1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3642', true);
select (restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'confiabilidad' ->> 'pedidos_falsos')::int as falsos_deberia_ser_1;
rollback;

\echo '=== D2. staff: desmarcar baja pedidos_falsos a 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3642', true);
select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3642', false);
select (restaurantes.cliente_ficha('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'confiabilidad' ->> 'pedidos_falsos')::int as falsos_deberia_ser_0;
rollback;

\echo '=== D3. cross-tenant: owner de B no marca el pedido de A (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select public.t_esperar_error($q$select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000c3602', '00000000-0000-0000-0000-0000000c3642', true)$q$, '42501') as sin_error;
rollback;

\echo '=== D4. repartidor no marca pedidos falsos (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3613', true);
select public.t_esperar_error($q$select restaurantes.cliente_marcar_pedido_falso('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3642', true)$q$, '42501') as sin_error;
rollback;

\echo '=== D5. politica: owner guarda umbral 3 y ventana 60; el sistema la lee en la memoria ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select restaurantes.cliente_politica_guardar('00000000-0000-0000-0000-0000000c3601', 3, 60);
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001') -> 'confiabilidad' ->> 'umbral')::int as umbral_deberia_ser_3;
rollback;

\echo '=== D6. politica: rol staff NO puede guardarla (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select public.t_esperar_error($q$select restaurantes.cliente_politica_guardar('00000000-0000-0000-0000-0000000c3601', 3, 60)$q$, '42501') as sin_error;
rollback;

\echo '=== D7. politica: valores fuera de rango (22023) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select public.t_esperar_error($q$select restaurantes.cliente_politica_guardar('00000000-0000-0000-0000-0000000c3601', 99, 60)$q$, '22023') as sin_error;
rollback;

\echo '=== D8. politica: umbral 0 (apagada) se lee como 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select restaurantes.cliente_politica_guardar('00000000-0000-0000-0000-0000000c3601', 0, 90);
select (restaurantes.cliente_politica_leer('00000000-0000-0000-0000-0000000c3601') ->> 'umbral_no_recogidos')::int as umbral_apagado_deberia_ser_0;
rollback;

\echo '=== D9. politica: un owner de otra organizacion no la cambia (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select public.t_esperar_error($q$select restaurantes.cliente_politica_guardar('00000000-0000-0000-0000-0000000c3601', 3, 60)$q$, '42501') as sin_error;
rollback;

\echo '=== E1. exportacion ARCO: incluye los gustos del titular ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select jsonb_array_length(restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'gustos') as gustos_exportados_deberia_ser_1;
rollback;

\echo '=== E2. borrar memoria: elimina domicilios y gustos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select restaurantes.cliente_borrar_memoria('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621');
select (jsonb_array_length(restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'domicilios')
      + jsonb_array_length(restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621') -> 'gustos')) as restante_deberia_ser_0;
rollback;

\echo '=== E3. borrar memoria: otro tenant = 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select public.t_esperar_error($q$select restaurantes.cliente_borrar_memoria('00000000-0000-0000-0000-0000000c3602', '00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== F1. tabla: owner A ve el gusto de Ana por SELECT directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select count(*)::int as gustos_visibles_deberia_ser_1 from restaurantes.customer_preferences;
rollback;

\echo '=== F2. tabla: owner de B no ve ningun gusto de A (aislamiento por tenant) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select count(*)::int as gustos_ajenos_deberia_ser_0 from restaurantes.customer_preferences;
rollback;

\echo '=== F3. tabla: el repartidor no ve gustos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3613', true);
select count(*)::int as gustos_repartidor_deberia_ser_0 from restaurantes.customer_preferences;
rollback;

\echo '=== F4. tabla: la sesion de sistema no ve gustos por SELECT directo (solo por la funcion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as gustos_sistema_deberia_ser_0 from restaurantes.customer_preferences;
rollback;

\echo '=== F5. tabla: INSERT directo en gustos negado a authenticated (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select public.t_esperar_error($q$insert into restaurantes.customer_preferences (organization_id, customer_id, kind, value, source) values ('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621', 'nota', 'x', 'staff')$q$, '42501') as sin_error;
rollback;

\echo '=== F6. tabla: customer_pedido_cierre sin SELECT para authenticated (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select public.t_esperar_error($q$select count(*) from restaurantes.customer_pedido_cierre$q$, '42501') as sin_error;
rollback;

\echo '=== F7. tabla: anon sin acceso a customer_preferences (42501) ==='
begin;
set local role anon;
select public.t_esperar_error($q$select count(*) from restaurantes.customer_preferences$q$, '42501') as sin_error;
rollback;

\echo '=== F8. tabla: la politica no se escribe por INSERT directo (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select public.t_esperar_error($q$insert into restaurantes.cliente_politica (organization_id, umbral_no_recogidos) values ('00000000-0000-0000-0000-0000000c3601', 5)$q$, '42501') as sin_error;
rollback;

\echo '=== I1. auxiliar cliente_direcciones_json: un autenticado de OTRA organizacion no puede llamarlo directo (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select public.t_esperar_error($q$select restaurantes.cliente_direcciones_json('00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== I2. auxiliar cliente_gustos_json: sin EXECUTE para authenticated, ni siquiera el owner de la organizacion (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3611', true);
select public.t_esperar_error($q$select restaurantes.cliente_gustos_json('00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== I3. auxiliar cliente_confiabilidad_json: cross-tenant (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select public.t_esperar_error($q$select restaurantes.cliente_confiabilidad_json('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== I4. auxiliar cliente_politica_efectiva: sin EXECUTE para authenticated (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3614', true);
select public.t_esperar_error($q$select * from restaurantes.cliente_politica_efectiva('00000000-0000-0000-0000-0000000c3601')$q$, '42501') as sin_error;
rollback;

\echo '=== I5. auxiliares: la sesion de sistema (rol authenticated sin sub) tampoco los llama directo (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$select restaurantes.cliente_direcciones_json('00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== I6. auxiliares: anon sin EXECUTE (42501) ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.cliente_gustos_json('00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error;
rollback;

\echo '=== I7. ARCO: el rol staff NO exporta ni borra memoria (42501); solo owner/admin ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c3612', true);
select public.t_esperar_error($q$select restaurantes.cliente_exportar_arco('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error_exportar;
select public.t_esperar_error($q$select restaurantes.cliente_borrar_memoria('00000000-0000-0000-0000-0000000c3601', '00000000-0000-0000-0000-0000000c3621')$q$, '42501') as sin_error_borrar;
rollback;

\echo '=== G1. base SIN migrar: la funcion eliminada da 42883 y el bloque con subtransaccion recupera la transaccion ==='
begin;
drop function restaurantes.cliente_memoria(uuid, text);
do $$
begin
  begin
    perform restaurantes.cliente_memoria('00000000-0000-0000-0000-0000000c3601', '5511110001');
  exception when undefined_function then
    null;
  end;
end $$;
select 1 as transaccion_viva;
rollback;

\echo 'Los escenarios con should_fail/deberia_ser_N los valida run-gate.mjs; los demas deben completar sin error (t_esperar_error lanza si el SQLSTATE no es el esperado).'
