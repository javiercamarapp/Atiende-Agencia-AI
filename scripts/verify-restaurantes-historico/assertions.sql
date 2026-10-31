-- Verificacion contra Postgres REAL de las migraciones 140 (importacion de historial + perfil), 141 (fusion de duplicados) y 142 (segmentos).
-- Datos 100% sinteticos. Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): "as should_fail" = el escenario debe terminar
-- en ERROR; "deberia_ser_N" = el ultimo valor impreso debe ser N (un solo count(*) entero por escenario).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f6a00', 'restaurantes', 'Org A (historial)', 'org-a-historial'),
  ('00000000-0000-0000-0000-0000000f6b00', 'restaurantes', 'Org B (historial, ajena)', 'org-b-historial'),
  ('00000000-0000-0000-0000-0000000f6c00', 'restaurantes', 'Org C (segmentos)', 'org-c-historial')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000f6a01', '00000000-0000-0000-0000-0000000f6a00', 'restaurantes', 'Sucursal A1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f6e01', 'owner-a-hist@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f6e03', 'staff-a-hist@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000f6e05', 'owner-b-hist@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-0000000f6e06', 'owner-c-hist@example.com', 'Owner C', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f6e01', '00000000-0000-0000-0000-0000000f6a00', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f6e03', '00000000-0000-0000-0000-0000000f6a00', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f6e05', '00000000-0000-0000-0000-0000000f6b00', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f6e06', '00000000-0000-0000-0000-0000000f6c00', null, 'owner', 'owner')
on conflict do nothing;

-- Org A: c01 existente (nombre y pedidos que la importacion NO debe tocar); c02/c03 son el MISMO telefono escrito de dos formas (fusion).
insert into restaurantes.customers (id, organization_id, phone, name, order_count, last_order_at) values
  ('00000000-0000-0000-0000-0000000f6c01', '00000000-0000-0000-0000-0000000f6a00', '9990064001', 'Existente Uno', 2, now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000f6c02', '00000000-0000-0000-0000-0000000f6a00', '9990064002', 'Fusion Uno', 2, now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000f6c03', '00000000-0000-0000-0000-0000000f6a00', '529990064002', null, 1, now() - interval '20 days'),
  ('00000000-0000-0000-0000-0000000f6c99', '00000000-0000-0000-0000-0000000f6b00', '9990064001', 'Cliente de B', 1, now())
on conflict do nothing;
insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000f6d01', '00000000-0000-0000-0000-0000000f6a00', '00000000-0000-0000-0000-0000000f6a01', '00000000-0000-0000-0000-0000000f6c03', 'Fusion Dos', '529990064002', 120, 'entregado', '[]'::jsonb, 'voice', now() - interval '20 days')
on conflict do nothing;
insert into restaurantes.customer_addresses (customer_id, label, address, is_default) values
  ('00000000-0000-0000-0000-0000000f6c02', 'Casa', 'Calle X 1', true),
  ('00000000-0000-0000-0000-0000000f6c03', 'Trabajo', 'calle x 1', true),
  ('00000000-0000-0000-0000-0000000f6c03', 'Otro', 'Calle Y 2', false)
on conflict do nothing;
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at, revocado_at) values
  ('00000000-0000-0000-0000-0000000f6a00', '00000000-0000-0000-0000-0000000f6c02', 'whatsapp', 'otorgado', 'panel', 'v1', now(), null),
  ('00000000-0000-0000-0000-0000000f6a00', '00000000-0000-0000-0000-0000000f6c03', 'whatsapp', 'revocado', 'baja_whatsapp', 'v1', now() - interval '1 day', now())
on conflict do nothing;

-- Filas de importacion: f1 actualiza a c01 (con una categoria de queja invalida), f2 crea un cliente con revision humana, f3 telefono de 9 digitos
-- (rechazada), f4 con un numero ilegible (rechazada por la base sin tumbar el lote).
create or replace function public.t_hist_filas() returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('fila', 1, 'telefono', '9990064001', 'nombre', 'Otro Nombre', 'direccion', 'Calle Sintetica 1', 'colonia', 'Montebello',
      'canal', 'domicilio', 'pago', 'efectivo', 'tortilla', 'maiz', 'salsas', jsonb_build_array('verde'), 'favoritos', jsonb_build_array('pastor'),
      'pedidos', 5, 'gasto_mxn', 1000, 'ticket_mxn', 200, 'primer_pedido', '2026-01-05', 'ultimo_pedido', '2026-10-20', 'estado', 'activo',
      'quejas', jsonb_build_array('demora', 'invalida'), 'banderas', jsonb_build_array('colonia_inferida_alta'), 'huella', repeat('a', 64)),
    jsonb_build_object('fila', 2, 'telefono', '9990064010', 'nombre', 'Nuevo Dos', 'pedidos', 2, 'gasto_mxn', 300, 'ticket_mxn', 150,
      'ultimo_pedido', '2026-10-01', 'estado', 'queja_abierta', 'quejas', jsonb_build_array('cobro'), 'banderas', jsonb_build_array('revision_humana'),
      'huella', repeat('b', 64)),
    jsonb_build_object('fila', 3, 'telefono', '999006401', 'huella', repeat('c', 64)),
    jsonb_build_object('fila', 4, 'telefono', '9990064011', 'pedidos', 'abc', 'huella', repeat('d', 64))
  );
$$;
grant execute on function public.t_hist_filas() to public;

-- Org C: cartera para segmentos (fecha de referencia fija 2026-10-31). Mismos datos que tests/historico-perfil-segmentos-duplicados.spec.ts.

insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f6f01', '00000000-0000-0000-0000-0000000f6c00', '9990065001', 'Segmento 01') on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f6f02', '00000000-0000-0000-0000-0000000f6c00', '9990065002', 'Segmento 02') on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f6f03', '00000000-0000-0000-0000-0000000f6c00', '9990065003', 'Segmento 03') on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f6f04', '00000000-0000-0000-0000-0000000f6c00', '9990065004', 'Segmento 04') on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f6f05', '00000000-0000-0000-0000-0000000f6c00', '9990065005', 'Segmento 05') on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f6f06', '00000000-0000-0000-0000-0000000f6c00', '9990065006', 'Segmento 06') on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f6f07', '00000000-0000-0000-0000-0000000f6c00', '9990065007', 'Segmento 07') on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f6f08', '00000000-0000-0000-0000-0000000f6c00', '9990065008', 'Segmento 08') on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f6f09', '00000000-0000-0000-0000-0000000f6c00', '9990065009', 'Segmento 09') on conflict do nothing;

insert into restaurantes.customer_historial_resumen (customer_id, organization_id, pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, revision_humana, huella) values ('00000000-0000-0000-0000-0000000f6f01', '00000000-0000-0000-0000-0000000f6c00', 10, 3000, 300, null, '2026-01-01', '2026-10-20', false, repeat('e', 64)) on conflict do nothing;
insert into restaurantes.customer_historial_resumen (customer_id, organization_id, pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, revision_humana, huella) values ('00000000-0000-0000-0000-0000000f6f02', '00000000-0000-0000-0000-0000000f6c00', 5, 2500, 500, null, '2026-01-01', '2026-08-01', false, repeat('e', 64)) on conflict do nothing;
insert into restaurantes.customer_historial_resumen (customer_id, organization_id, pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, revision_humana, huella) values ('00000000-0000-0000-0000-0000000f6f03', '00000000-0000-0000-0000-0000000f6c00', 2, 200, 100, null, '2026-01-01', '2026-05-01', false, repeat('e', 64)) on conflict do nothing;
insert into restaurantes.customer_historial_resumen (customer_id, organization_id, pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, revision_humana, huella) values ('00000000-0000-0000-0000-0000000f6f04', '00000000-0000-0000-0000-0000000f6c00', 1, 90, 90, null, '2026-10-15', '2026-10-15', false, repeat('e', 64)) on conflict do nothing;
insert into restaurantes.customer_historial_resumen (customer_id, organization_id, pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, revision_humana, huella) values ('00000000-0000-0000-0000-0000000f6f05', '00000000-0000-0000-0000-0000000f6c00', 3, 300, 100, null, '2026-02-01', '2026-10-01', false, repeat('e', 64)) on conflict do nothing;
insert into restaurantes.customer_historial_resumen (customer_id, organization_id, pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, revision_humana, huella) values ('00000000-0000-0000-0000-0000000f6f06', '00000000-0000-0000-0000-0000000f6c00', 4, 150, 100, null, '2026-01-01', '2026-02-01', true, repeat('e', 64)) on conflict do nothing;
insert into restaurantes.customer_historial_resumen (customer_id, organization_id, pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, revision_humana, huella) values ('00000000-0000-0000-0000-0000000f6f07', '00000000-0000-0000-0000-0000000f6c00', 4, 4400, 1100, 12, '2026-01-01', '2026-10-28', false, repeat('e', 64)) on conflict do nothing;
insert into restaurantes.customer_historial_resumen (customer_id, organization_id, pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, revision_humana, huella) values ('00000000-0000-0000-0000-0000000f6f08', '00000000-0000-0000-0000-0000000f6c00', 1, 2100, 2100, null, '2026-09-01', '2026-09-01', false, repeat('e', 64)) on conflict do nothing;
insert into restaurantes.customer_historial_resumen (customer_id, organization_id, pedidos, gasto_mxn, ticket_mxn, kilos_totales, primer_pedido, ultimo_pedido, revision_humana, huella) values ('00000000-0000-0000-0000-0000000f6f09', '00000000-0000-0000-0000-0000000f6c00', 1, 1999, 2000, null, '2026-01-01', '2026-10-30', false, repeat('e', 64)) on conflict do nothing;

\echo ''
\echo '=== A) importar_historial ==='

\echo '--- A1. vista previa: 0 filas de resumen escritas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_0 from restaurantes.customer_historial_resumen where organization_id = '00000000-0000-0000-0000-0000000f6a00';
rollback;

\echo '--- A2. vista previa: 0 lotes y 0 clientes importados ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_0 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f6a00' and origen = 'importacion_historica';
rollback;

\echo '--- A3. vista previa informa 1 creada, 1 actualizada, 2 rechazadas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select count(*) as deberia_ser_1 from (select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false, public.t_hist_filas()) as r) x where (x.r->>'creadas') = '1' and (x.r->>'actualizadas') = '1' and (x.r->>'rechazadas') = '2';
rollback;

\echo '--- A4. aplicar: crea 1 cliente con origen importacion_historica ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_1 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f6a00' and origen = 'importacion_historica';
rollback;

\echo '--- A5. aplicar: 2 resumenes (el existente y el nuevo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_2 from restaurantes.customer_historial_resumen where organization_id = '00000000-0000-0000-0000-0000000f6a00';
rollback;

\echo '--- A6. NO pisa el nombre ni mueve order_count del cliente existente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_1 from restaurantes.customers where id = '00000000-0000-0000-0000-0000000f6c01' and name = 'Existente Uno' and order_count = 2 and last_order_at is not null and origen = 'canal';
rollback;

\echo '--- A7. NO crea pedidos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_1 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000f6a00';
rollback;

\echo '--- A8. NO otorga consentimiento de marketing (solo los 2 de fixture, de c02/c03) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_2 from restaurantes.marketing_consentimiento where organization_id = '00000000-0000-0000-0000-0000000f6a00';
rollback;

\echo '--- A9. quejas: solo categorias validas ('invalida' se descarta) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_2 from restaurantes.customer_quejas_historicas where organization_id = '00000000-0000-0000-0000-0000000f6a00' and categoria in ('demora', 'cobro');
rollback;

\echo '--- A10. quejas: ninguna categoria fuera de catalogo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_0 from restaurantes.customer_quejas_historicas where organization_id = '00000000-0000-0000-0000-0000000f6a00' and categoria not in ('demora', 'faltante', 'cobro', 'salsas', 'cancelado', 'equivocado', 'otra');
rollback;

\echo '--- A11. la fila con queja abierta queda marcada para revision humana ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_1 from restaurantes.customer_historial_resumen where organization_id = '00000000-0000-0000-0000-0000000f6a00' and revision_humana;
rollback;

\echo '--- A12. domicilio historico con colonia, predeterminado solo si no habia otro ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_1 from restaurantes.customer_addresses where customer_id = '00000000-0000-0000-0000-0000000f6c01' and label = 'Histórico' and colonia = 'Montebello' and is_default;
rollback;

\echo '--- A13. todo cliente importado tiene telefono de 10 digitos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_0 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f6a00' and origen = 'importacion_historica' and phone !~ '^[0-9]{10}$';
rollback;

\echo '--- A14. idempotente: la segunda corrida da 0 creadas, 0 actualizadas, 2 sin cambios ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_1 from restaurantes.import_historico_lote where organization_id = '00000000-0000-0000-0000-0000000f6a00' and creadas = 0 and actualizadas = 0 and sin_cambios = 2 and rechazadas = 2;
rollback;

\echo '--- A15. el lote registra por fila solo ids y huellas (2 filas aceptadas; las rechazadas no dejan rastro) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_2 from restaurantes.import_historico_fila f join restaurantes.import_historico_lote l on l.id = f.lote_id where l.organization_id = '00000000-0000-0000-0000-0000000f6a00';
rollback;

\echo '--- A16. un titular suprimido por ARCO no se reimporta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
reset role;
select set_config('app.nuevo', (select id::text from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f6a00' and phone = '9990064010'), true);
set local role authenticated;
select restaurantes.historial_borrar('00000000-0000-0000-0000-0000000f6a00', current_setting('app.nuevo')::uuid);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', true, public.t_hist_filas());
reset role;
select count(*) as deberia_ser_0 from restaurantes.customer_historial_resumen h join restaurantes.customers c on c.id = h.customer_id where c.phone = '9990064010';
rollback;

\echo '--- A17. CROSS-TENANT: el owner de otra organizacion no puede importar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e05', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas()) as should_fail;
rollback;

\echo '--- A18. staff (no admin) no puede importar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e03', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false, public.t_hist_filas()) as should_fail;
rollback;

\echo '--- A19. la sesion de sistema no puede importar ---'
begin;
set local role authenticated;
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false, public.t_hist_filas()) as should_fail;
rollback;

\echo '--- A20. anon sin EXECUTE ---'
begin;
set local role anon;
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', false, public.t_hist_filas()) as should_fail;
rollback;

\echo '--- A21. huella de archivo invalida ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'no-es-sha', false, public.t_hist_filas()) as should_fail;
rollback;

\echo '--- A22. las tablas nuevas no son legibles directo por authenticated ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select count(*) as should_fail from restaurantes.customer_historial_resumen;
rollback;

\echo ''
\echo '=== B) cliente_perfil_historico (solo sistema) ==='

\echo '--- B1. sistema lee el perfil del cliente importado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from (select restaurantes.cliente_perfil_historico('00000000-0000-0000-0000-0000000f6a00', '9990064001') as r) x where x.r is not null and (x.r->'historico'->>'pedidos') = '5' and (x.r->'domicilios'->0->>'importado') = 'true';
rollback;

\echo '--- B2. cliente sin historial importado -> null ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from (select restaurantes.cliente_perfil_historico('00000000-0000-0000-0000-0000000f6a00', '9990064002') as r) x where x.r is null;
rollback;

\echo '--- B3. CROSS-TENANT: el telefono de A consultado con la organizacion B -> null ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from (select restaurantes.cliente_perfil_historico('00000000-0000-0000-0000-0000000f6b00', '9990064001') as r) x where x.r is null;
rollback;

\echo '--- B4. un usuario autenticado no puede usar la funcion de sistema ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.cliente_perfil_historico('00000000-0000-0000-0000-0000000f6a00', '9990064001') as should_fail;
rollback;

\echo '--- B5. anon sin EXECUTE ---'
begin;
set local role anon;
select restaurantes.cliente_perfil_historico('00000000-0000-0000-0000-0000000f6a00', '9990064001') as should_fail;
rollback;

\echo ''
\echo '=== C) ARCO ==='

\echo '--- C1. exportar devuelve el resumen del titular ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
select count(*) as deberia_ser_1 from (select restaurantes.historial_exportar('00000000-0000-0000-0000-0000000f6a00', '00000000-0000-0000-0000-0000000f6c01') as r) x where (x.r->'resumen'->>'pedidos') = '5';
rollback;

\echo '--- C2. borrar elimina el resumen ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
select restaurantes.historial_borrar('00000000-0000-0000-0000-0000000f6a00', '00000000-0000-0000-0000-0000000f6c01');
reset role;
select count(*) as deberia_ser_0 from restaurantes.customer_historial_resumen where customer_id = '00000000-0000-0000-0000-0000000f6c01';
rollback;

\echo '--- C3. borrar elimina el domicilio historico y deja la supresion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.importar_historial('00000000-0000-0000-0000-0000000f6a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true, public.t_hist_filas());
select restaurantes.historial_borrar('00000000-0000-0000-0000-0000000f6a00', '00000000-0000-0000-0000-0000000f6c01');
reset role;
select count(*) as deberia_ser_1 from restaurantes.import_historico_supresion s where s.organization_id = '00000000-0000-0000-0000-0000000f6a00' and not exists (select 1 from restaurantes.customer_addresses a where a.customer_id = '00000000-0000-0000-0000-0000000f6c01' and a.label = 'Histórico');
rollback;

\echo '--- C4. staff (no admin) no puede exportar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e03', true);
select restaurantes.historial_exportar('00000000-0000-0000-0000-0000000f6a00', '00000000-0000-0000-0000-0000000f6c01') as should_fail;
rollback;

\echo '--- C5. CROSS-TENANT: owner de B no puede borrar a un titular de A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e05', true);
select restaurantes.historial_borrar('00000000-0000-0000-0000-0000000f6a00', '00000000-0000-0000-0000-0000000f6c01') as should_fail;
rollback;

\echo ''
\echo '=== D) historial_fusionar_duplicados ==='

\echo '--- D1. vista previa: informa 1 grupo y 1 absorbido y no escribe ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select count(*) as deberia_ser_1 from (select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', false) as r) x where (x.r->>'grupos') = '1' and (x.r->>'absorbidos') = '1';
rollback;

\echo '--- D2. vista previa: los dos clientes siguen existiendo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', false);
reset role;
select count(*) as deberia_ser_2 from restaurantes.customers where id in ('00000000-0000-0000-0000-0000000f6c02', '00000000-0000-0000-0000-0000000f6c03');
rollback;

\echo '--- D3. aplicar: queda un solo cliente para el telefono ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true);
reset role;
select count(*) as deberia_ser_1 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f6a00' and right(regexp_replace(phone, '\D', '', 'g'), 10) = '9990064002';
rollback;

\echo '--- D4. aplicar: sobrevive el de mas pedidos, con pedidos sumados y telefono canonico ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true);
reset role;
select count(*) as deberia_ser_1 from restaurantes.customers where id = '00000000-0000-0000-0000-0000000f6c02' and order_count = 3 and phone = '9990064002' and name = 'Fusion Uno';
rollback;

\echo '--- D5. aplicar: el pedido del absorbido pasa al sobreviviente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true);
reset role;
select count(*) as deberia_ser_1 from restaurantes.orders where customer_id = '00000000-0000-0000-0000-0000000f6c02';
rollback;

\echo '--- D6. aplicar: domicilios unidos sin duplicar el mismo texto (2 en total) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true);
reset role;
select count(*) as deberia_ser_2 from restaurantes.customer_addresses where customer_id = '00000000-0000-0000-0000-0000000f6c02';
rollback;

\echo '--- D7. aplicar: un solo domicilio predeterminado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true);
reset role;
select count(*) as deberia_ser_1 from restaurantes.customer_addresses where customer_id = '00000000-0000-0000-0000-0000000f6c02' and is_default;
rollback;

\echo '--- D8. aplicar: el consentimiento mas restrictivo gana (revocado) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true);
reset role;
select count(*) as deberia_ser_1 from restaurantes.marketing_consentimiento where customer_id = '00000000-0000-0000-0000-0000000f6c02' and estado = 'revocado';
rollback;

\echo '--- D9. aplicar: queda registro de la fusion (solo ids) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true);
reset role;
select count(*) as deberia_ser_1 from restaurantes.customer_fusion_historial where sobreviviente = '00000000-0000-0000-0000-0000000f6c02' and absorbido = '00000000-0000-0000-0000-0000000f6c03';
rollback;

\echo '--- D10. aplicar dos veces no vuelve a fusionar nada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true);
select count(*) as deberia_ser_1 from (select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true) as r) x where (x.r->>'grupos') = '0';
rollback;

\echo '--- D11. CROSS-TENANT: el owner de B no puede fusionar en A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e05', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', true) as should_fail;
rollback;

\echo '--- D12. staff (no admin) no puede fusionar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e03', true);
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', false) as should_fail;
rollback;

\echo '--- D13. anon sin EXECUTE ---'
begin;
set local role anon;
select restaurantes.historial_fusionar_duplicados('00000000-0000-0000-0000-0000000f6a00', false) as should_fail;
rollback;

\echo ''
\echo '=== E) historial_segmentos ==='

\echo '--- E. campeones: 1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_1 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where s.segmento = 'campeon';
rollback;

\echo '--- E. en riesgo de alto valor: 1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_1 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where s.segmento = 'en_riesgo_alto_valor';
rollback;

\echo '--- E. dormidos: 2 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_2 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where s.segmento = 'dormido';
rollback;

\echo '--- E. nuevos: 1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_1 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where s.segmento = 'nuevo';
rollback;

\echo '--- E. regulares: 4 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_4 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where s.segmento = 'regular';
rollback;

\echo '--- E. reactivables (la queja abierta NO lo es): 2 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_2 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where s.reactivable;
rollback;

\echo '--- E. cuentas de kilo: 1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_1 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where s.cuenta_kilo;
rollback;

\echo '--- E. candidatas a evento (ticket estrictamente mayor a 2000): 1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_1 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where s.candidata_evento;
rollback;

\echo '--- E. alto valor (percentil 0.75): 3 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_3 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where s.alto_valor;
rollback;

\echo '--- E. alias siempre de 8 caracteres: 0 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_0 from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') s where length(s.alias) <> 8;
rollback;

\echo '--- E11. resumen jsonb: 9 clientes y 1 campeon ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as deberia_ser_1 from (select restaurantes.historial_segmentos_resumen('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31') as r) x where (x.r->>'total') = '9' and (x.r->>'campeon') = '1' and (x.r->>'reactivables') = '2';
rollback;

\echo '--- E12. percentil fuera de rango ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e06', true);
select count(*) as should_fail from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31', 90, 45, 6, 30, 1.5);
rollback;

\echo '--- E13. CROSS-TENANT: el owner de A no ve la cartera de C ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e01', true);
select count(*) as should_fail from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31');
rollback;

\echo '--- E14. staff (no admin) rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f6e03', true);
select count(*) as should_fail from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6a00', date '2026-10-31');
rollback;

\echo '--- E15. anon sin EXECUTE ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.historial_segmentos('00000000-0000-0000-0000-0000000f6c00', date '2026-10-31');
rollback;

\echo ''
\echo 'fin de las verificaciones de historial'
