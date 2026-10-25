-- Fixtures + assertions contra Postgres REAL para packages/domain-restaurantes/migrations/099_agregados_pedido_por_validar.sql
-- (agregados a un pedido ya enviado: el agente crea la solicitud, una persona de la sucursal la acepta o rechaza).
--
--   A. Lectura: owner, admin ACOTADO a una sucursal, staff y sistema ven lo suyo; el repartidor no; otra organizacion no; anon no tiene ni SELECT.
--   B. Creacion: solo por la funcion de SISTEMA (nadie inserta directo), sobre un pedido de la MISMA organizacion y sucursal y en estado agregable; un abierto
--      por pedido; idempotente por evento; CHECK de forma y de importes; el barrido del sistema trae el pedido.
--   C. Decision: compare-and-set sobre `pendiente` (doble clic = un efecto), alcance por sucursal, sin suplantacion, aceptar aplica al pedido,
--      rechazar exige motivo, vencido es de sistema, un estado final no se mueve.
--   D. Guardia: un usuario no puede cambiar lo que pidio el cliente (items/importes/nota/version); el sistema si (fusion).
--   E. Bitacora append-only: el actor es quien escribe, sin suplantacion, sin UPDATE/DELETE, con alcance por sucursal.
--   F. Base SIN migrar: la tabla eliminada da 42P01 y un SAVEPOINT real la recupera.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `..._deberia_ser_N` marca el valor esperado; un escenario sin alias debe
-- terminar sin error. Para exigir un ERROR de SQLSTATE exacto se usa public.t_esperar_error (falla si la sentencia NO falla o falla con otro codigo).
\pset pager off

create or replace function public.t_esperar_error(p_sql text, p_estado text) returns text
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
    return 'ok';
  end;
  raise exception 'se esperaba SQLSTATE % y la sentencia no fallo', p_estado;
end $$;
grant execute on function public.t_esperar_error(text, text) to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f0a01', 'restaurantes', 'Agregados Org A', 'agregados-a'),
  ('00000000-0000-0000-0000-0000000f0a02', 'restaurantes', 'Agregados Org B (ajena)', 'agregados-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0a01', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000f0b02', '00000000-0000-0000-0000-0000000f0a01', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000f0b03', '00000000-0000-0000-0000-0000000f0a02', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0a01', 'ag-a1'),
  ('00000000-0000-0000-0000-0000000f0b02', '00000000-0000-0000-0000-0000000f0a01', 'ag-a2'),
  ('00000000-0000-0000-0000-0000000f0b03', '00000000-0000-0000-0000-0000000f0a02', 'ag-b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f0c01', 'ag-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0c02', 'ag-admin-a1@example.com', 'Admin acotado A1', 'seed'),
  ('00000000-0000-0000-0000-0000000f0c03', 'ag-staff-a@example.com', 'Staff A (todas)', 'seed'),
  ('00000000-0000-0000-0000-0000000f0c04', 'ag-repartidor-a@example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0c05', 'ag-owner-b@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-0000000f0c06', 'ag-staff-a2@example.com', 'Staff solo A2', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f0c01', '00000000-0000-0000-0000-0000000f0a01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f0c02', '00000000-0000-0000-0000-0000000f0a01', array['00000000-0000-0000-0000-0000000f0b01']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000f0c03', '00000000-0000-0000-0000-0000000f0a01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f0c04', '00000000-0000-0000-0000-0000000f0a01', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f0c05', '00000000-0000-0000-0000-0000000f0a02', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f0c06', '00000000-0000-0000-0000-0000000f0a01', array['00000000-0000-0000-0000-0000000f0b02']::uuid[], 'member', 'staff')
on conflict do nothing;

-- Pedidos: d1/d2 de A1 (preparando), d3 de A2 (pending), d4 de A1 en camino, d5 de A1 pending, d6 de A1 pending (sin solicitud), e1 de la Org B.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal) values
  ('00000000-0000-0000-0000-0000000f0d01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'Ana', '5511111111', 100, 'preparando', '[{"id":"p1","name":"Taco","price":25,"quantity":4}]', 'whatsapp', 'domicilio'),
  ('00000000-0000-0000-0000-0000000f0d02', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'Beto', '5522222222', 200, 'preparando', '[]', 'whatsapp', 'recoger'),
  ('00000000-0000-0000-0000-0000000f0d03', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b02', 'Caro', '5533333333', 300, 'pending', '[]', 'whatsapp', 'domicilio'),
  ('00000000-0000-0000-0000-0000000f0d04', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'Dani', '5544444444', 400, 'en_camino', '[]', 'whatsapp', 'domicilio'),
  ('00000000-0000-0000-0000-0000000f0d05', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'Eva', '5555555555', 500, 'pending', '[]', 'voice', 'recoger'),
  ('00000000-0000-0000-0000-0000000f0d06', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'Fer', '5566666666', 600, 'pending', '[]', 'whatsapp', 'recoger'),
  ('00000000-0000-0000-0000-0000000f0e01', '00000000-0000-0000-0000-0000000f0a02', '00000000-0000-0000-0000-0000000f0b03', 'Gus', '5599999999', 100, 'pending', '[]', 'web', 'domicilio');

-- Solicitudes (insertadas como superusuario: la sesion de sistema se prueba mas abajo): g1 y g2 en A1 (pedidos d1, d2), g3 en A2 (d3), gb en B.
insert into restaurantes.order_amendments (id, organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after) values
  ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d01', 'whatsapp', '[{"id":"p2","name":"Coca","price":30,"quantity":2}]', 100, 60, 160),
  ('00000000-0000-0000-0000-0000000f0f02', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d02', 'voice', '[{"id":"p2","name":"Coca","price":30,"quantity":1}]', 200, 30, 230),
  ('00000000-0000-0000-0000-0000000f0f03', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b02', '00000000-0000-0000-0000-0000000f0d03', 'whatsapp', '[{"id":"p2","name":"Coca","price":30,"quantity":1}]', 300, 30, 330),
  ('00000000-0000-0000-0000-0000000f0f0b', '00000000-0000-0000-0000-0000000f0a02', '00000000-0000-0000-0000-0000000f0b03', '00000000-0000-0000-0000-0000000f0e01', 'whatsapp', '[{"id":"p2","name":"Coca","price":30,"quantity":1}]', 100, 30, 130);

\echo ''
\echo '=== A) Lectura ==='

\echo '--- 1. owner de la Org A ve las 3 solicitudes de su organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
select count(*) as filas_visibles_deberia_ser_3 from restaurantes.order_amendments;
rollback;

\echo '--- 2. admin ACOTADO a A1 ve solo las 2 de A1 (no la de A2) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c02', true);
select count(*) as filas_visibles_deberia_ser_2 from restaurantes.order_amendments;
rollback;

\echo '--- 3. staff de todas las sucursales ve las 3 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
select count(*) as filas_visibles_deberia_ser_3 from restaurantes.order_amendments;
rollback;

\echo '--- 4. staff solo de A2 ve solo la de A2 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c06', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.order_amendments;
rollback;

\echo '--- 5. el repartidor NO ve ninguna ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c04', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.order_amendments;
rollback;

\echo '--- 6. owner de la Org B solo ve la suya (cross-tenant) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c05', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.order_amendments;
rollback;

\echo '--- 7. sesion de SISTEMA (auth.uid() NULL) ve las 4 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_visibles_deberia_ser_4 from restaurantes.order_amendments;
rollback;

\echo '--- 8. anon no tiene ni SELECT: RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.order_amendments;
rollback;

\echo ''
\echo '=== B) Creacion ==='

\echo '--- 9. el SISTEMA crea la solicitud con agregado_crear_sistema (valida pedido, organizacion y sucursal) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2","name":"Coca","price":30,"quantity":1}]', 30, null, 'wamid-1')->>'estado') = 'creado' as creada_deberia_ser_t;
rollback;

\echo '--- 10. la solicitud creada trae el total del PEDIDO (500 + 30 = 530) y los datos del pedido para avisar al cliente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2","name":"Coca","price":30,"quantity":1}]', 30, null, null)->'agregado'->>'total_after')::numeric::int as total_nuevo_deberia_ser_530;
rollback;

\echo '--- 11. el mismo evento devuelve «repetido» sin crear otra ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2","name":"Coca","price":30,"quantity":1}]', 30, null, 'wamid-1');
select (restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2","name":"Coca","price":30,"quantity":1}]', 30, null, 'wamid-1')->>'estado') = 'repetido' as repetida_deberia_ser_t;
rollback;

\echo '--- 12. un pedido que ya tiene una solicitud abierta devuelve «abierto» (para fusionar), nunca una segunda ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d01', 'whatsapp', '[{"id":"p2","name":"Coca","price":30,"quantity":1}]', 30, null, 'wamid-2')->>'estado') = 'abierto' as abierto_deberia_ser_t;
rollback;

\echo '--- 13. sucursal que no es la del pedido, u organizacion ajena: pedido_no_encontrado (nunca cruza tenants) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b02', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2"}]', 30, null, null)->>'estado') = 'pedido_no_encontrado' as sucursal_ajena_deberia_ser_t;
select (restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a02', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2"}]', 30, null, null)->>'estado') = 'pedido_no_encontrado' as org_ajena_deberia_ser_t;
rollback;

\echo '--- 14. un pedido en camino no admite agregados: pedido_no_agregable ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d04', 'voice', '[{"id":"p2"}]', 30, null, null)->>'estado') = 'pedido_no_agregable' as en_camino_deberia_ser_t;
rollback;

\echo '--- 15. un USUARIO (staff) no puede llamar la funcion de sistema: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
select public.t_esperar_error($q$select restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2"}]', 30, null, null)$q$, '42501') as crear;
select public.t_esperar_error($q$select restaurantes.agregado_leer_sistema('00000000-0000-0000-0000-0000000f0f01')$q$, '42501') as leer;
select public.t_esperar_error($q$select restaurantes.agregados_barrido_sistema(now(), 10)$q$, '42501') as barrido;
rollback;

\echo '--- 16. anon no ejecuta ninguna: RECHAZADO ---'
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.agregado_crear_sistema('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2"}]', 30, null, null)$q$, '42501') as crear;
select public.t_esperar_error($q$select restaurantes.agregados_barrido_sistema(now(), 10)$q$, '42501') as barrido;
rollback;

\echo '--- 17. el helper interno no se concede a nadie (ni a un usuario): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
select public.t_esperar_error($q$select restaurantes.agregado_vista_json('00000000-0000-0000-0000-0000000f0f01')$q$, '42501') as error_esperado;
rollback;

\echo '--- 18. NADIE inserta directo en order_amendments (ni el sistema, ni staff, ni anon): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2"}]', 500, 30, 530)$q$, '42501') as sistema_directo;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2"}]', 500, 30, 530)$q$, '42501') as staff_directo;
rollback;

\echo '--- 19. el barrido del sistema devuelve las pendientes con los datos del pedido (nombre y telefono para avisar) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.agregados_barrido_sistema(now() + interval '1 minute', 50)) as pendientes_deberia_ser_4;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.agregados_barrido_sistema(now() + interval '1 minute', 50)->0->>'customer_phone') is not null as trae_telefono_del_pedido_deberia_ser_t;
rollback;

\echo '--- 20. un SEGUNDO abierto para el mismo pedido: RECHAZADO (indice unico parcial, 23505) ---'
begin;
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d01', 'voice', '[{"id":"p2"}]', 100, 30, 130)$q$, '23505') as error_esperado;
rollback;

\echo '--- 21. el mismo evento (source_event_id) no crea dos solicitudes (23505) ---'
begin;
insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after, source_event_id)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2"}]', 500, 30, 530, 'wamid-9');
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after, source_event_id)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d06', 'voice', '[{"id":"p2"}]', 600, 30, 630, 'wamid-9')$q$, '23505') as error_esperado;
rollback;

\echo '--- 22. CHECK: total_after distinto de antes + agregado: RECHAZADO ---'
begin;
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2"}]', 500, 30, 999)$q$, '23514') as error_esperado;
rollback;

\echo '--- 23. CHECK: renglones vacios, mas de 30 o no-arreglo: RECHAZADO ---'
begin;
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[]', 500, 0, 500)$q$, '23514') as vacio_rechazado;
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '{"a":1}', 500, 0, 500)$q$, '23514') as objeto_rechazado;
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after)
  select '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', (select jsonb_agg('{"id":"x"}'::jsonb) from generate_series(1, 31)), 500, 0, 500$q$, '23514') as treinta_y_uno_rechazado;
rollback;

\echo '--- 24. CHECK: nota de mas de 300 caracteres y canal invalido: RECHAZADO ---'
begin;
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after, customer_note)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'voice', '[{"id":"p2"}]', 500, 30, 530, repeat('x', 301))$q$, '23514') as nota_larga;
select public.t_esperar_error($q$insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after)
  values ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0d05', 'sms', '[{"id":"p2"}]', 500, 30, 530)$q$, '23514') as canal_invalido;
rollback;

\echo ''
\echo '=== C) Decision ==='

\echo '--- 25. staff ACEPTA: la solicitud pasa a aceptado con su id y el pedido recibe renglones y total en la misma transaccion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
with a as (update restaurantes.order_amendments set status = 'aceptado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c03' where id = '00000000-0000-0000-0000-0000000f0f01' and status = 'pendiente' returning id),
     o as (update restaurantes.orders set items = coalesce(items, '[]'::jsonb) || '[{"id":"p2","name":"Coca","price":30,"quantity":2}]'::jsonb, total = total + 60 where id = '00000000-0000-0000-0000-0000000f0d01' and status = any(array['programado','pending','preparando','listo_para_recoger']) returning id)
select (select count(*) from a) + (select count(*) from o) as filas_actualizadas_deberia_ser_2;
rollback;

\echo '--- 26. tras aceptar, el pedido quedo con total 160 y 2 renglones ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
update restaurantes.order_amendments set status = 'aceptado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c03' where id = '00000000-0000-0000-0000-0000000f0f01';
update restaurantes.orders set items = coalesce(items, '[]'::jsonb) || '[{"id":"p2","name":"Coca","price":30,"quantity":2}]'::jsonb, total = total + 60 where id = '00000000-0000-0000-0000-0000000f0d01';
select count(*) as pedidos_con_total_160_y_2_renglones_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000f0d01' and total = 160 and jsonb_array_length(items) = 2;
rollback;

\echo '--- 27. DOBLE CLIC: el segundo compare-and-set no actualiza ninguna fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
update restaurantes.order_amendments set status = 'aceptado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c03' where id = '00000000-0000-0000-0000-0000000f0f01' and status = 'pendiente';
with a as (update restaurantes.order_amendments set status = 'aceptado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c03' where id = '00000000-0000-0000-0000-0000000f0f01' and status = 'pendiente' returning id)
select count(*) as segunda_actualizacion_deberia_ser_0 from a;
rollback;

\echo '--- 28. owner RECHAZA con motivo de lista cerrada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
with a as (update restaurantes.order_amendments set status = 'rechazado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c01', reject_reason = 'producto_agotado', reject_note = 'sin refrescos' where id = '00000000-0000-0000-0000-0000000f0f02' returning id)
select count(*) as filas_rechazadas_deberia_ser_1 from a;
rollback;

\echo '--- 29. rechazar SIN motivo: RECHAZADO por CHECK ---'
begin;
select public.t_esperar_error($q$update restaurantes.order_amendments set status = 'rechazado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c01' where id = '00000000-0000-0000-0000-0000000f0f02'$q$, '23514') as error_esperado;
rollback;

\echo '--- 30. motivo fuera de la lista cerrada: RECHAZADO por CHECK ---'
begin;
select public.t_esperar_error($q$update restaurantes.order_amendments set status = 'rechazado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c01', reject_reason = 'porque_si' where id = '00000000-0000-0000-0000-0000000f0f02'$q$, '23514') as error_esperado;
rollback;

\echo '--- 31. SUPLANTACION: staff resuelve a nombre del owner: RECHAZADO por la policy ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
select public.t_esperar_error($q$update restaurantes.order_amendments set status = 'aceptado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c01' where id = '00000000-0000-0000-0000-0000000f0f01'$q$, '42501') as error_esperado;
rollback;

\echo '--- 32. admin ACOTADO a A1 NO decide la solicitud de A2: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c02', true);
with a as (update restaurantes.order_amendments set status = 'aceptado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c02' where id = '00000000-0000-0000-0000-0000000f0f03' returning id)
select count(*) as filas_actualizadas_deberia_ser_0 from a;
rollback;

\echo '--- 33. el repartidor NO decide: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c04', true);
with a as (update restaurantes.order_amendments set status = 'aceptado', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c04' where id = '00000000-0000-0000-0000-0000000f0f01' returning id)
select count(*) as filas_actualizadas_deberia_ser_0 from a;
rollback;

\echo '--- 34. owner de la Org B NO decide la de la Org A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c05', true);
with a as (update restaurantes.order_amendments set status = 'rechazado', reject_reason = 'otro', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c05' where id = '00000000-0000-0000-0000-0000000f0f01' returning id)
select count(*) as filas_actualizadas_deberia_ser_0 from a;
rollback;

\echo '--- 35. owner de la Org B NO puede tocar el PEDIDO de la Org A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c05', true);
with o as (update restaurantes.orders set total = total + 60 where id = '00000000-0000-0000-0000-0000000f0d01' returning id)
select count(*) as filas_actualizadas_deberia_ser_0 from o;
rollback;

\echo '--- 36. el SISTEMA cierra como vencido (sin decided_by) una solicitud pendiente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with a as (update restaurantes.order_amendments set status = 'vencido', escalation_level = 2, escalated_at = now(), decided_at = now() where id = '00000000-0000-0000-0000-0000000f0f02' and status = 'pendiente' returning id)
select count(*) as filas_vencidas_deberia_ser_1 from a;
rollback;

\echo '--- 37. el sistema sube el escalamiento a 1 (aviso de los 10 min) sin cerrar la solicitud ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with a as (update restaurantes.order_amendments set escalation_level = 1, escalated_at = now() where id = '00000000-0000-0000-0000-0000000f0f02' and status = 'pendiente' and escalation_level = 0 returning id)
select count(*) as filas_escaladas_deberia_ser_1 from a;
rollback;

\echo '--- 38. aceptado sin decided_by (nadie acepto): RECHAZADO por CHECK ---'
begin;
select public.t_esperar_error($q$update restaurantes.order_amendments set status = 'aceptado', decided_at = now() where id = '00000000-0000-0000-0000-0000000f0f02'$q$, '23514') as error_esperado;
rollback;

\echo '--- 39. pendiente con decided_at, o resuelta sin decided_at: RECHAZADO por CHECK ---'
begin;
select public.t_esperar_error($q$update restaurantes.order_amendments set decided_at = now() where id = '00000000-0000-0000-0000-0000000f0f02'$q$, '23514') as pendiente_con_fecha;
select public.t_esperar_error($q$update restaurantes.order_amendments set status = 'vencido' where id = '00000000-0000-0000-0000-0000000f0f02'$q$, '23514') as resuelta_sin_fecha;
rollback;

\echo '--- 40. una solicitud RESUELTA no se mueve ni por el sistema (trigger, 22023) ---'
begin;
update restaurantes.order_amendments set status = 'rechazado', reject_reason = 'otro', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c01' where id = '00000000-0000-0000-0000-0000000f0f02';
select public.t_esperar_error($q$update restaurantes.order_amendments set status = 'aceptado', reject_reason = null, decided_by = '00000000-0000-0000-0000-0000000f0c01' where id = '00000000-0000-0000-0000-0000000f0f02'$q$, '22023') as error_esperado;
rollback;

\echo '--- 41. un usuario no puede reabrir una resuelta: 0 filas (la policy solo deja actualizar pendientes) ---'
begin;
update restaurantes.order_amendments set status = 'rechazado', reject_reason = 'otro', decided_at = now(), decided_by = '00000000-0000-0000-0000-0000000f0c01' where id = '00000000-0000-0000-0000-0000000f0f02';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
with a as (update restaurantes.order_amendments set escalation_level = 2 where id = '00000000-0000-0000-0000-0000000f0f02' returning id)
select count(*) as filas_actualizadas_deberia_ser_0 from a;
rollback;

\echo '--- 42. sin DELETE para authenticated: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
select public.t_esperar_error($q$delete from restaurantes.order_amendments where id = '00000000-0000-0000-0000-0000000f0f01'$q$, '42501') as error_esperado;
rollback;

\echo '--- 43. GRANT por columna: organization_id / order_id / property_id no cambian: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
select public.t_esperar_error($q$update restaurantes.order_amendments set organization_id = '00000000-0000-0000-0000-0000000f0a02' where id = '00000000-0000-0000-0000-0000000f0f01'$q$, '42501') as org_bloqueada;
select public.t_esperar_error($q$update restaurantes.order_amendments set order_id = '00000000-0000-0000-0000-0000000f0d06' where id = '00000000-0000-0000-0000-0000000f0f01'$q$, '42501') as pedido_bloqueado;
select public.t_esperar_error($q$update restaurantes.order_amendments set requested_at = now() where id = '00000000-0000-0000-0000-0000000f0f01'$q$, '42501') as cronometro_bloqueado;
rollback;

\echo ''
\echo '=== D) Guardia: lo que pidio el cliente no lo cambia un usuario ==='

\echo '--- 44. un usuario no cambia items_added: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
select public.t_esperar_error($q$update restaurantes.order_amendments set items_added = '[{"id":"p9","name":"Caro","price":1,"quantity":1}]' where id = '00000000-0000-0000-0000-0000000f0f01'$q$, '42501') as error_esperado;
rollback;

\echo '--- 45. un usuario no cambia los importes ni la version ni la nota: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
select public.t_esperar_error($q$update restaurantes.order_amendments set total_added = 0, total_after = 100 where id = '00000000-0000-0000-0000-0000000f0f01'$q$, '42501') as importes;
select public.t_esperar_error($q$update restaurantes.order_amendments set version = 9 where id = '00000000-0000-0000-0000-0000000f0f01'$q$, '42501') as version;
select public.t_esperar_error($q$update restaurantes.order_amendments set customer_note = 'otra' where id = '00000000-0000-0000-0000-0000000f0f01'$q$, '42501') as nota;
rollback;

\echo '--- 46. el SISTEMA si fusiona (items, importes, version) en la solicitud abierta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with a as (update restaurantes.order_amendments set items_added = items_added || '[{"id":"p3","name":"Agua","price":20,"quantity":1}]'::jsonb, total_added = 80, total_after = 180, version = version + 1 where id = '00000000-0000-0000-0000-0000000f0f01' and status = 'pendiente' returning id)
select count(*) as filas_fusionadas_deberia_ser_1 from a;
rollback;

\echo ''
\echo '=== E) Bitacora append-only ==='

\echo '--- 47. staff anota un evento a su nombre ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
with e as (insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind, actor_user_id, detail) values ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'visto', 'usuario', '00000000-0000-0000-0000-0000000f0c03', '{}') returning id)
select count(*) as eventos_deberia_ser_1 from e;
rollback;

\echo '--- 48. staff anota un evento a nombre de OTRA persona: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
select public.t_esperar_error($q$insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind, actor_user_id) values ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'visto', 'usuario', '00000000-0000-0000-0000-0000000f0c01')$q$, '42501') as error_esperado;
rollback;

\echo '--- 49. staff anota un evento de agente o de sistema (no es el): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c03', true);
select public.t_esperar_error($q$insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind) values ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'creado', 'agente')$q$, '42501') as error_esperado;
rollback;

\echo '--- 50. el sistema anota un evento de agente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with e as (insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind, detail) values ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'creado', 'agente', '{"canal":"whatsapp"}') returning id)
select count(*) as eventos_deberia_ser_1 from e;
rollback;

\echo '--- 51. actor_kind usuario sin usuario, o agente con usuario: RECHAZADO por CHECK ---'
begin;
select public.t_esperar_error($q$insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind) values ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'visto', 'usuario')$q$, '23514') as usuario_sin_id;
select public.t_esperar_error($q$insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind, actor_user_id) values ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'creado', 'agente', '00000000-0000-0000-0000-0000000f0c01')$q$, '23514') as agente_con_id;
rollback;

\echo '--- 52. evento con propiedad distinta a la de su solicitud: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($q$insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind) values ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b02', 'creado', 'agente')$q$, '42501') as error_esperado;
rollback;

\echo '--- 53. la bitacora NO se actualiza ni se borra (ni por el owner): RECHAZADO ---'
begin;
insert into restaurantes.order_amendment_events (id, amendment_id, organization_id, property_id, event_type, actor_kind) values ('00000000-0000-0000-0000-0000000f0aa1', '00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'creado', 'agente');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c01', true);
select public.t_esperar_error($q$update restaurantes.order_amendment_events set event_type = 'aceptado' where id = '00000000-0000-0000-0000-0000000f0aa1'$q$, '42501') as sin_update;
select public.t_esperar_error($q$delete from restaurantes.order_amendment_events where id = '00000000-0000-0000-0000-0000000f0aa1'$q$, '42501') as sin_delete;
rollback;

\echo '--- 54. el admin ACOTADO a A1 no lee los eventos de A2 ni el repartidor ninguno ---'
begin;
insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind) values
  ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'creado', 'agente'),
  ('00000000-0000-0000-0000-0000000f0f03', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b02', 'creado', 'agente');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c02', true);
select count(*) as eventos_visibles_deberia_ser_1 from restaurantes.order_amendment_events;
rollback;

begin;
insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind) values
  ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'creado', 'agente');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0c04', true);
select count(*) as eventos_del_repartidor_deberia_ser_0 from restaurantes.order_amendment_events;
rollback;

\echo '--- 55. detail acotado: un jsonb de mas de 4 kB o que no es objeto: RECHAZADO ---'
begin;
select public.t_esperar_error($q$insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind, detail) values ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'creado', 'agente', jsonb_build_object('x', repeat('a', 5000)))$q$, '23514') as grande;
select public.t_esperar_error($q$insert into restaurantes.order_amendment_events (amendment_id, organization_id, property_id, event_type, actor_kind, detail) values ('00000000-0000-0000-0000-0000000f0f01', '00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0b01', 'creado', 'agente', '[1]')$q$, '23514') as no_objeto;
rollback;

\echo ''
\echo '=== F) Base sin migrar ==='

\echo '--- 56. sin la tabla (42P01) un SAVEPOINT + ROLLBACK TO SAVEPOINT deja la transaccion usable ---'
begin;
drop table restaurantes.order_amendment_events;
drop table restaurantes.order_amendments;
savepoint sp_verify_agregados;
do $$
declare
  v_state text;
begin
  begin
    perform 1 from restaurantes.order_amendments;
    raise exception 'se esperaba SQLSTATE 42P01 y la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_agregados;
release savepoint sp_verify_agregados;
select 1 as siguiente_consulta_del_request_deberia_ser_1;
rollback;

\echo '--- 57. REVERSA documentada: borrar las tablas y la funcion deja la base como antes (los pedidos no cambian) ---'
begin;
drop function restaurantes.agregados_barrido_sistema(timestamptz, integer);
drop function restaurantes.agregado_leer_sistema(uuid);
drop function restaurantes.agregado_crear_sistema(uuid, uuid, uuid, text, jsonb, numeric, text, text);
drop function restaurantes.agregado_vista_json(uuid);
drop table restaurantes.order_amendment_events;
drop table restaurantes.order_amendments;
drop function restaurantes.order_amendments_guardia();
select count(*) as pedidos_intactos_deberia_ser_7 from restaurantes.orders where organization_id in ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-0000000f0a02');
rollback;
