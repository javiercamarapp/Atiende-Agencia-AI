-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales, rol `authenticated`) de
-- packages/domain-restaurantes/migrations/084_cfo_huecos_frecuentes_p90_es_venta_forma_pago.sql (CFO-02b). Corpus pequeno cuyos valores se calcularon a mano.
--
-- Corpus (todo con cierre p_hasta = 2026-06-30, ventana de frecuentes 90 dias = 2026-04-02..2026-06-30):
--   H1: dos sucursales (P1, P2) y 9 clientes c1..c9 con bordes de frecuente (3 en 90 dias si, 2 no, el pedido del dia 91 no cuenta), de dormido (30 dias exactos
--       si), cliente repartido entre sucursales (frecuente solo en el conjunto), ruido que NO cuenta (cancelado, programado, por_aprobar, sin cliente) y
--       'completado' que SI cuenta. Mas importaciones de SoftRestaurant con forma de pago (P1) y una en P2.
--   H2: organizacion ajena (Q1). H3: umbrales propios en cfo_config (n = 2, 30 dias). H4: descuentos con p90 conocido (S1 20 dias, S2 10 dias) y
--       pedidos de todos los estados para es_venta. H5: organizacion sin pedidos. H6: volumen (6 000 pedidos, 1 500 clientes, 3 sucursales).
--   Seguridad: owner (H1, H3, H4, H5, H6), admin acotado a P1, staff, owner ajeno, anon, sistema.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; alias `..._deberia_ser_N` marca el entero esperado; el helper
-- t_esperar_error exige el SQLSTATE exacto.
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

-- Inserta un pedido en la hora LOCAL indicada (America/Mexico_City).
create or replace function public.t_ped(p_org uuid, p_prop uuid, p_cust uuid, p_dia date, p_hora time, p_total numeric, p_status text default 'entregado',
  p_items jsonb default '[]'::jsonb) returns uuid
language plpgsql as $$
declare
  v_ts timestamptz := (p_dia + p_hora) at time zone 'America/Mexico_City';
  v_id uuid := gen_random_uuid();
begin
  insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, canal, created_at,
                                   delivered_at, programado_para)
  values (v_id, p_org, p_prop, p_cust, 'Cliente', '+52 5500000000', p_total, p_status, p_items, 'whatsapp', 'recoger', v_ts,
          case when p_status in ('entregado', 'completado') then v_ts + interval '30 minutes' end,
          case when p_status = 'programado' then v_ts + interval '5 days' end);
  return v_id;
end $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e8501', 'restaurantes', 'CFO2b H1', 'cfo2b-h1'),
  ('00000000-0000-0000-0000-0000000e8502', 'restaurantes', 'CFO2b H2 ajena', 'cfo2b-h2'),
  ('00000000-0000-0000-0000-0000000e8503', 'restaurantes', 'CFO2b H3 config', 'cfo2b-h3'),
  ('00000000-0000-0000-0000-0000000e8504', 'restaurantes', 'CFO2b H4 descuentos', 'cfo2b-h4'),
  ('00000000-0000-0000-0000-0000000e8505', 'restaurantes', 'CFO2b H5 vacia', 'cfo2b-h5'),
  ('00000000-0000-0000-0000-0000000e8506', 'restaurantes', 'CFO2b H6 volumen', 'cfo2b-h6')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8501', 'Sucursal P1'), ('00000000-0000-0000-0000-0000000e85a2', '00000000-0000-0000-0000-0000000e8501', 'Sucursal P2'),
  ('00000000-0000-0000-0000-0000000e85b1', '00000000-0000-0000-0000-0000000e8502', 'Sucursal Q1'),
  ('00000000-0000-0000-0000-0000000e85c1', '00000000-0000-0000-0000-0000000e8503', 'Sucursal R1'),
  ('00000000-0000-0000-0000-0000000e85d1', '00000000-0000-0000-0000-0000000e8504', 'Sucursal S1'), ('00000000-0000-0000-0000-0000000e85d2', '00000000-0000-0000-0000-0000000e8504', 'Sucursal S2'),
  ('00000000-0000-0000-0000-0000000e85e1', '00000000-0000-0000-0000-0000000e8505', 'Sucursal E1'),
  ('00000000-0000-0000-0000-0000000e85f1', '00000000-0000-0000-0000-0000000e8506', 'Sucursal V1'), ('00000000-0000-0000-0000-0000000e85f2', '00000000-0000-0000-0000-0000000e8506', 'Sucursal V2'), ('00000000-0000-0000-0000-0000000e85f3', '00000000-0000-0000-0000-0000000e8506', 'Sucursal V3')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria, lat, lng)
select p.id, p.organization_id, 'b-' || right(p.id::text, 4), null, null, null from core.property p where p.organization_id in
  ('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e8502', '00000000-0000-0000-0000-0000000e8503', '00000000-0000-0000-0000-0000000e8504', '00000000-0000-0000-0000-0000000e8505', '00000000-0000-0000-0000-0000000e8506')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e8511', 'owner@cfo2b.example.com', 'Owner', 'seed'),
  ('00000000-0000-0000-0000-0000000e8512', 'admin-p1@cfo2b.example.com', 'Admin P1', 'seed'),
  ('00000000-0000-0000-0000-0000000e8513', 'staff@cfo2b.example.com', 'Staff', 'seed'),
  ('00000000-0000-0000-0000-0000000e8515', 'owner-ajeno@cfo2b.example.com', 'Owner ajeno', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e8511', '00000000-0000-0000-0000-0000000e8501', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e8511', '00000000-0000-0000-0000-0000000e8503', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e8511', '00000000-0000-0000-0000-0000000e8504', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e8511', '00000000-0000-0000-0000-0000000e8505', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e8511', '00000000-0000-0000-0000-0000000e8506', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e8512', '00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e8513', '00000000-0000-0000-0000-0000000e8501', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e8515', '00000000-0000-0000-0000-0000000e8502', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.customers (id, organization_id, phone, name) values
  ('00000000-0000-0000-0000-0000000e8521', '00000000-0000-0000-0000-0000000e8501', '+52 5500008501', 'c1'), ('00000000-0000-0000-0000-0000000e8522', '00000000-0000-0000-0000-0000000e8501', '+52 5500008502', 'c2'), ('00000000-0000-0000-0000-0000000e8523', '00000000-0000-0000-0000-0000000e8501', '+52 5500008503', 'c3'),
  ('00000000-0000-0000-0000-0000000e8524', '00000000-0000-0000-0000-0000000e8501', '+52 5500008504', 'c4'), ('00000000-0000-0000-0000-0000000e8525', '00000000-0000-0000-0000-0000000e8501', '+52 5500008505', 'c5'), ('00000000-0000-0000-0000-0000000e8526', '00000000-0000-0000-0000-0000000e8501', '+52 5500008506', 'c6'),
  ('00000000-0000-0000-0000-0000000e8527', '00000000-0000-0000-0000-0000000e8501', '+52 5500008507', 'c7'), ('00000000-0000-0000-0000-0000000e8529', '00000000-0000-0000-0000-0000000e8501', '+52 5500008509', 'c9'),
  ('00000000-0000-0000-0000-0000000e8531', '00000000-0000-0000-0000-0000000e8503', '+52 5500008531', 'd1'), ('00000000-0000-0000-0000-0000000e8532', '00000000-0000-0000-0000-0000000e8503', '+52 5500008532', 'd2'), ('00000000-0000-0000-0000-0000000e8533', '00000000-0000-0000-0000-0000000e8503', '+52 5500008533', 'd3');

-- H1 (hasta = 2026-06-30; ventana 2026-04-02..2026-06-30). Cada pedido vale 100.
-- c1: 3 pedidos en P1, el ultimo el 05-10 (51 dias) -> frecuente dormido.
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8521', date '2026-04-05', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8521', date '2026-04-20', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8521', date '2026-05-10', time '15:00', 100);
-- c2: 3 pedidos, el ultimo el 06-20 (10 dias) -> frecuente, NO dormido.
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8522', date '2026-05-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8522', date '2026-06-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8522', date '2026-06-20', time '15:00', 100);
-- c3: 2 pedidos -> no frecuente.
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8523', date '2026-04-10', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8523', date '2026-04-12', time '15:00', 100);
-- c4: borde de ventana (04-02 cuenta), ultimo 05-31 = 30 dias exactos -> frecuente dormido con M = 30.
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8524', date '2026-04-02', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8524', date '2026-04-03', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8524', date '2026-05-31', time '15:00', 100);
-- c5: 3 pedidos pero el primero el 04-01 (dia 91, fuera de la ventana) -> 2 en ventana -> no frecuente.
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8525', date '2026-04-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8525', date '2026-04-05', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8525', date '2026-05-02', time '15:00', 100);
-- c6: 2 pedidos en P1 y 1 en P2 -> frecuente SOLO en el conjunto (3), dormido (ultimo 05-04 = 57 dias).
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8526', date '2026-05-02', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8526', date '2026-05-03', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a2', '00000000-0000-0000-0000-0000000e8526', date '2026-05-04', time '15:00', 100);
-- c7: solo 2 pedidos validos (entregado y completado); el ruido (cancelado, programado, por_aprobar) NO cuenta.
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8527', date '2026-05-01', time '15:00', 100, 'entregado');
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8527', date '2026-05-04', time '15:00', 100, 'completado');
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8527', date '2026-05-02', time '15:00', 100, 'cancelado');
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8527', date '2026-05-03', time '15:00', 100, 'programado');
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e8527', date '2026-05-05', time '15:00', 100, 'por_aprobar');
-- sin cliente: 3 pedidos que no entran a ninguna metrica de clientes.
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', null, date '2026-05-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', null, date '2026-05-02', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', null, date '2026-05-03', time '15:00', 100);
-- c9: 4 pedidos en P2 (dormido: ultimo 04-13).
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a2', '00000000-0000-0000-0000-0000000e8529', date '2026-04-10', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a2', '00000000-0000-0000-0000-0000000e8529', date '2026-04-11', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a2', '00000000-0000-0000-0000-0000000e8529', date '2026-04-12', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a2', '00000000-0000-0000-0000-0000000e8529', date '2026-04-13', time '15:00', 100);
-- Cliente de la organizacion H3 con pedidos en H1? No: H3 es otra organizacion con sus propios clientes.
-- H2 (ajena): un cliente frecuente dormido que jamas debe aparecer en H1.
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000e8541', '00000000-0000-0000-0000-0000000e8502', '+52 5500008541', 'z1');
select public.t_ped('00000000-0000-0000-0000-0000000e8502', '00000000-0000-0000-0000-0000000e85b1', '00000000-0000-0000-0000-0000000e8541', date '2026-04-05', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8502', '00000000-0000-0000-0000-0000000e85b1', '00000000-0000-0000-0000-0000000e8541', date '2026-04-06', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8502', '00000000-0000-0000-0000-0000000e85b1', '00000000-0000-0000-0000-0000000e8541', date '2026-04-07', time '15:00', 100);

-- H3: umbrales propios (n = 2, 30 dias).
insert into restaurantes.cfo_config (organization_id, frecuente_n, frecuente_dias) values ('00000000-0000-0000-0000-0000000e8503', 2, 30);
-- d1: 06-01 y 06-02 (28 dias sin pedir); d2: 06-10..06-12 (18 dias); d3: un solo pedido.
select public.t_ped('00000000-0000-0000-0000-0000000e8503', '00000000-0000-0000-0000-0000000e85c1', '00000000-0000-0000-0000-0000000e8531', date '2026-06-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8503', '00000000-0000-0000-0000-0000000e85c1', '00000000-0000-0000-0000-0000000e8531', date '2026-06-02', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8503', '00000000-0000-0000-0000-0000000e85c1', '00000000-0000-0000-0000-0000000e8532', date '2026-06-10', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8503', '00000000-0000-0000-0000-0000000e85c1', '00000000-0000-0000-0000-0000000e8532', date '2026-06-11', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8503', '00000000-0000-0000-0000-0000000e85c1', '00000000-0000-0000-0000-0000000e8532', date '2026-06-12', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e8503', '00000000-0000-0000-0000-0000000e85c1', '00000000-0000-0000-0000-0000000e8533', date '2026-06-05', time '15:00', 100);

-- H4: descuentos. Cada pedido de venta lleva un renglon de 100 (bruta 10 000 centavos).
--   S1 dias 06-01..06-20: total = 100 - i (descuento i %), alternando entregado/completado.
do $$
declare
  i integer;
begin
  for i in 1..20 loop
    perform public.t_ped('00000000-0000-0000-0000-0000000e8504', '00000000-0000-0000-0000-0000000e85d1', null, date '2026-06-01' + (i - 1), time '15:00', 100 - i,
      case when i % 2 = 0 then 'entregado' else 'completado' end, '[{"id":"x","name":"n","price":100,"quantity":1}]'::jsonb);
  end loop;
  -- S2 dias 06-01..06-10: total 50 (descuento 50 %).
  for i in 1..10 loop
    perform public.t_ped('00000000-0000-0000-0000-0000000e8504', '00000000-0000-0000-0000-0000000e85d2', null, date '2026-06-01' + (i - 1), time '15:00', 50, 'entregado', '[{"id":"x","name":"n","price":100,"quantity":1}]'::jsonb);
  end loop;
end $$;
-- Ruido: fuera de ventana (05-31, 100 % de descuento), cancelado, bruta 0, falso, por_aprobar, programado.
select public.t_ped('00000000-0000-0000-0000-0000000e8504', '00000000-0000-0000-0000-0000000e85d1', null, date '2026-05-31', time '15:00', 0, 'entregado', '[{"id":"x","name":"n","price":100,"quantity":1}]'::jsonb);
select public.t_ped('00000000-0000-0000-0000-0000000e8504', '00000000-0000-0000-0000-0000000e85d1', null, date '2026-06-25', time '15:00', 0, 'cancelado', '[{"id":"x","name":"n","price":100,"quantity":1}]'::jsonb);
select public.t_ped('00000000-0000-0000-0000-0000000e8504', '00000000-0000-0000-0000-0000000e85d1', null, date '2026-06-26', time '15:00', 100, 'entregado', '[]'::jsonb);
do $$
declare
  v uuid;
begin
  v := public.t_ped('00000000-0000-0000-0000-0000000e8504', '00000000-0000-0000-0000-0000000e85d1', null, date '2026-06-27', time '15:00', 0, 'entregado', '[{"id":"x","name":"n","price":100,"quantity":1}]'::jsonb);
  update restaurantes.orders set pedido_falso_at = now() where id = v;
end $$;
select public.t_ped('00000000-0000-0000-0000-0000000e8504', '00000000-0000-0000-0000-0000000e85d2', null, date '2026-06-12', time '15:00', 0, 'por_aprobar', '[{"id":"x","name":"n","price":100,"quantity":1}]'::jsonb);
select public.t_ped('00000000-0000-0000-0000-0000000e8504', '00000000-0000-0000-0000-0000000e85d2', null, date '2026-06-13', time '15:00', 0, 'programado', '[{"id":"x","name":"n","price":100,"quantity":1}]'::jsonb);

-- H6: volumen. 1 500 clientes, 4 pedidos cada uno (6 000), sucursal = (i % 3) + 1; el primero cae entre 04-10 y 04-29; todos dormidos.
insert into restaurantes.customers (id, organization_id, phone, name)
select ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, '00000000-0000-0000-0000-0000000e8506', '+52 55' || lpad(i::text, 8, '0'), 'v' || i from generate_series(1, 1500) i;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, canal, created_at, delivered_at)
select '00000000-0000-0000-0000-0000000e8506', (array['00000000-0000-0000-0000-0000000e85f1', '00000000-0000-0000-0000-0000000e85f2', '00000000-0000-0000-0000-0000000e85f3'])[(i % 3) + 1]::uuid, ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'Cliente', '+52 5500000000',
       90, 'entregado', '[{"id":"x","name":"n","price":100,"quantity":1}]'::jsonb, 'whatsapp', 'recoger',
       ((date '2026-04-10' + (i % 20) + k) + time '15:00') at time zone 'America/Mexico_City',
       ((date '2026-04-10' + (i % 20) + k) + time '15:30') at time zone 'America/Mexico_City'
  from generate_series(1, 1500) i, generate_series(0, 3) k;
analyze restaurantes.orders;

-- SoftRestaurant (H1): importado como owner con el rol REAL authenticated.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', false);
select aceptados from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', repeat('b', 64), 'resumen_servicio', 'ventas.csv', '[
  {"dia_negocio":"2026-03-10","tipo_servicio":"comedor","forma_pago":"Efectivo","tickets":10,"bruta_centavos":100000,"descuento_centavos":5000,"cancelado_centavos":2000,"propina_centavos":8000,"iva_centavos":13103,"neta_centavos":95000},
  {"dia_negocio":"2026-03-10","tipo_servicio":"comedor","forma_pago":"TARJETA","tickets":5,"bruta_centavos":50000,"descuento_centavos":0,"cancelado_centavos":0,"propina_centavos":4000,"iva_centavos":6896,"neta_centavos":50000},
  {"dia_negocio":"2026-03-10","tipo_servicio":"domicilio","tickets":3,"bruta_centavos":9000,"neta_centavos":9000},
  {"dia_negocio":"2026-03-11","tipo_servicio":"comedor","forma_pago":"tarjeta","tickets":2,"bruta_centavos":20000,"neta_centavos":20000,"iva_centavos":2759}
]'::jsonb);
select aceptados from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a2', repeat('c', 64), 'resumen_servicio', 'p2.csv', '[
  {"dia_negocio":"2026-03-10","tipo_servicio":"comedor","forma_pago":"efectivo","tickets":1,"bruta_centavos":1000,"neta_centavos":1000}
]'::jsonb);
reset role;

-- ===========================================================================
-- A. cfo_clientes_frecuentes_dormidos
-- ===========================================================================
\echo '=== A1. P1 (n=3, 90 dias, M=30): c1, c2 y c4 son frecuentes; c1 y c4 (borde de 30 dias exactos) dormidos con 6 pedidos y 600 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (frecuentes = 3 and frecuentes_dormidos = 2 and pedidos_ventana = 6 and neta_ventana_centavos = 60000 and frecuente_n = 3 and frecuente_dias = 90 and dormido_dias = 30)::int as p1_deberia_ser_1
  from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30') where property_id = '00000000-0000-0000-0000-0000000e85a1' and alcance = 'sucursal';
rollback;

\echo '=== A2. P2: solo c9 (4 pedidos, dormido); c6 tiene un solo pedido ahi ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (frecuentes = 1 and frecuentes_dormidos = 1 and pedidos_ventana = 4 and neta_ventana_centavos = 40000)::int as p2_deberia_ser_1
  from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30') where property_id = '00000000-0000-0000-0000-0000000e85a2';
rollback;

\echo '=== A3. conjunto: c6 es frecuente solo aqui (3 entre sucursales) -> 5 frecuentes, 4 dormidos, 13 pedidos; NO es la suma de sucursales (3 dormidos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (c.property_id is null and c.frecuentes = 5 and c.frecuentes_dormidos = 4 and c.pedidos_ventana = 13 and c.neta_ventana_centavos = 130000
        and (select sum(s.frecuentes_dormidos) from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30') s where s.alcance = 'sucursal') = 3)::int as conjunto_deberia_ser_1
  from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30') c where c.alcance = 'conjunto';
rollback;

\echo '=== A4. un renglon por sucursal permitida mas el del conjunto (3), sin otras organizaciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (count(*) = 3 and count(*) filter (where alcance = 'conjunto') = 1 and count(*) filter (where property_id in ('00000000-0000-0000-0000-0000000e85b1', '00000000-0000-0000-0000-0000000e85c1', '00000000-0000-0000-0000-0000000e85d1')) = 0)::int as renglones_deberia_ser_1
  from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30');
rollback;

\echo '=== A5. umbral de dormido: M = 51 deja solo a c1 (51 dias); M = 52 deja cero ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select ((select frecuentes_dormidos from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-06-30', null, null, 51) where alcance = 'sucursal') = 1
    and (select frecuentes_dormidos from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-06-30', null, null, 52) where alcance = 'sucursal') = 0)::int as umbral_deberia_ser_1;
rollback;

\echo '=== A6. sobreescribir n: con n = 4 solo c9 (en P2) es frecuente; con n = 2 tambien c3, c5 y c7 en P1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select ((select frecuentes from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 4) where alcance = 'conjunto') = 1
    and (select frecuentes from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-06-30', 2) where alcance = 'sucursal') = 7)::int as n_deberia_ser_1;
rollback;

\echo '=== A7. umbrales de cfo_config de la organizacion (H3: n = 2, 30 dias) cuando no se mandan; los parametros mandan sobre la configuracion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select ((select (frecuente_n = 2 and frecuente_dias = 30 and frecuentes = 2 and frecuentes_dormidos = 0) from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8503', null, date '2026-06-30') where alcance = 'conjunto')
    and (select (frecuentes = 2 and frecuentes_dormidos = 2) from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8503', null, date '2026-06-30', null, null, 7) where alcance = 'conjunto')
    and (select (frecuente_n = 3 and frecuentes = 1 and frecuentes_dormidos = 1) from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8503', null, date '2026-06-30', 3, null, 7) where alcance = 'conjunto'))::int as config_deberia_ser_1;
rollback;

\echo '=== A8. si M >= la ventana nadie es frecuente y dormido a la vez: cero, sin error ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (frecuentes_dormidos = 0)::int as ventana_deberia_ser_1 from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 3, 30, 31) where alcance = 'conjunto';
rollback;

\echo '=== A9. misma definicion de frecuente que cfo_clientes_resumen (082): las dos cuentas coinciden por sucursal y en el conjunto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select count(*)::int as distintos_deberia_ser_0
  from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 3, 90, 30) d
  join restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-01', date '2026-06-30', 3, 90, 60, 120) r on r.alcance = d.alcance and r.property_id is not distinct from d.property_id
 where d.frecuentes <> r.frecuentes;
rollback;

\echo '=== A10. muestra: top 2 del conjunto por pedidos (c9 con 4, luego un empate de 3), alias hash de 8 caracteres y SOLO las llaves permitidas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (jsonb_array_length(muestra) = 2
        and muestra -> 0 ->> 'alias' = left(encode(sha256(convert_to('00000000-0000-0000-0000-0000000e8529'::text, 'UTF8')), 'hex'), 8)
        and (muestra -> 0 ->> 'pedidos')::int = 4 and (muestra -> 0 ->> 'dias_sin_pedir')::int = 78 and (muestra -> 0 ->> 'neta_centavos')::int = 40000
        and (muestra -> 1 ->> 'pedidos')::int = 3
        and (select array_agg(k order by k) from jsonb_object_keys(muestra -> 0) k) = array['alias', 'dias_sin_pedir', 'neta_centavos', 'pedidos']
        and muestra::text !~* '(nombre|telefono|phone|name|@)')::int as muestra_deberia_ser_1
  from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', null, null, 30, 2) where alcance = 'conjunto';
rollback;

\echo '=== A11. sin muestra pedida (default 0) el arreglo viene vacio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (count(*) = 3 and count(*) filter (where muestra = '[]'::jsonb) = 3)::int as vacio_deberia_ser_1 from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30');
rollback;

\echo '=== A12. datos vacios: organizacion sin pedidos devuelve sucursal + conjunto en cero con muestra vacia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (count(*) = 2 and sum(frecuentes) = 0 and sum(frecuentes_dormidos) = 0 and sum(pedidos_ventana) = 0 and sum(neta_ventana_centavos) = 0)::int as vacia_deberia_ser_1
  from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8505', null, date '2026-06-30', null, null, 30, 5);
rollback;

\echo '=== A13. admin acotado (solo P1): ve P1 y un conjunto calculado SOLO con P1 (3 frecuentes, 2 dormidos); c6 y c9 no cuentan ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8512', true);
select (count(*) = 2 and count(*) filter (where property_id = '00000000-0000-0000-0000-0000000e85a2') = 0
        and (select frecuentes_dormidos from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30') where alcance = 'conjunto') = 2)::int as acotado_deberia_ser_1
  from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30');
rollback;

\echo '=== A14. RECHAZADO: admin acotado pide P2 (sucursal ajena a su alcance) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8512', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a2']::uuid[], date '2026-06-30')$q$, '42501') as rechazo_ok;
rollback;

\echo '=== A15. RECHAZADO: staff y owner de otra organizacion -> 42501 (con p_props nulo y con sucursales concretas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8513', true);
do $$
begin
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30')$q$, '42501');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8515', true);
do $$
begin
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-06-30')$q$, '42501');
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== A16. RECHAZADO multi-organizacion: el owner de H1 y H3 pide sucursales de H3 (o de la ajena H2) con la organizacion H1 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
do $$
begin
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85c1']::uuid[], date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1', '00000000-0000-0000-0000-0000000e85b1']::uuid[], date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8502', null, date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85d1']::uuid[], date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-06-01', date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85b1']::uuid[], date '2026-03-10', date '2026-03-11')$q$, '42501');
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== A17. RECHAZADO: anon sin execute -> 42501 en las 4 funciones ==='
begin;
set local role anon;
do $$
begin
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-01', date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', null, date '2026-03-10', date '2026-03-11')$q$, '42501');
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== A18. RECHAZADO: sistema (sin usuario) con una sucursal de otra organizacion -> 42501; con p_props nulo ve solo las 2 de la organizacion declarada ==='
begin;
set local role authenticated;
do $$
begin
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85b1']::uuid[], date '2026-06-30')$q$, '42501');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85b1']::uuid[], date '2026-06-30')$q$, '42501');
end $$;
select (count(*) = 3 and count(*) filter (where property_id in ('00000000-0000-0000-0000-0000000e85b1', '00000000-0000-0000-0000-0000000e85c1')) = 0)::int as sistema_deberia_ser_1 from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30');
rollback;

\echo '=== A19. RECHAZADO: limites de parametros (22023) = los de cfo_config ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
do $$
begin
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 0)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 21)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 3, 29)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 3, 366)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 3, 90, 6)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 3, 90, 366)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 3, 90, null)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 3, 90, 30, -1)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 3, 90, 30, 51)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, null)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', array[]::uuid[], date '2026-06-30')$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_clientes_frecuentes_dormidos(null, null, date '2026-06-30')$q$, '22023');
end $$;
select 1 as limites_ok;
rollback;

\echo '=== A20. los limites aceptan los extremos exactos de cfo_config (n 1 y 20, dias 30 y 365, dormido 7 y 365, muestra 0 y 50) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (
  (select count(*) from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 1, 30, 7, 0)) = 3
  and (select count(*) from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', 20, 365, 365, 50)) = 3)::int as extremos_deberia_ser_1;
rollback;

-- ===========================================================================
-- B. cfo_descuento_p90
-- ===========================================================================
\echo '=== B1. S1 (20 dias con descuentos 1..20 %): p90 = 18.10 (interpolacion lineal), 20 dias con venta, ventana 30 dias ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (p90_pct = 18.10 and dias_con_venta = 20 and dias = 30 and desde = date '2026-06-01' and hasta = date '2026-06-30' and alcance = 'sucursal')::int as s1_deberia_ser_1
  from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-30', 30) where property_id = '00000000-0000-0000-0000-0000000e85d1';
rollback;

\echo '=== B2. S2 solo tiene 10 dias con venta: p90 NULL (no se inventa con menos de 14 dias) pero se informa dias_con_venta = 10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (p90_pct is null and dias_con_venta = 10)::int as s2_deberia_ser_1 from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-30', 30) where property_id = '00000000-0000-0000-0000-0000000e85d2';
rollback;

\echo '=== B3. conjunto: descuento % diario de la SUMA de sucursales (25.5..30 y 11..20): p90 = 29.05, 20 dias ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (property_id is null and p90_pct = 29.05 and dias_con_venta = 20 and alcance = 'conjunto')::int as conjunto_deberia_ser_1
  from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-30', 30) where alcance = 'conjunto';
rollback;

\echo '=== B4. el ruido NO entra: cancelado, por_aprobar, falso, programado, bruta 0 y el pedido de 05-31 (fuera de ventana) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select ((select dias_con_venta from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', array['00000000-0000-0000-0000-0000000e85d1']::uuid[], date '2026-06-30', 30) where alcance = 'sucursal') = 20)::int as sin_ruido_deberia_ser_1;
rollback;

\echo '=== B5. ventana de 60 dias: entra el pedido de 05-31 con 100 % -> 21 dias y p90 = 19.00 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (dias_con_venta = 21 and p90_pct = 19.00 and dias = 60)::int as ventana_deberia_ser_1 from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', array['00000000-0000-0000-0000-0000000e85d1']::uuid[], date '2026-06-30', 60) where alcance = 'sucursal';
rollback;

\echo '=== B6. datos vacios: organizacion sin pedidos devuelve sucursal + conjunto con 0 dias y p90 NULL ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (count(*) = 2 and sum(dias_con_venta) = 0 and count(*) filter (where p90_pct is not null) = 0)::int as vacia_deberia_ser_1 from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8505', null, date '2026-06-30');
rollback;

\echo '=== B7. sin descuentos (H1: pedidos sin renglones, bruta 0) el p90 es NULL con 0 dias ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (count(*) = 3 and sum(dias_con_venta) = 0)::int as sin_bruta_deberia_ser_1 from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30');
rollback;

\echo '=== B8. admin acotado de H1: solo P1 y el conjunto (2 renglones), nunca P2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8512', true);
select (count(*) = 2 and count(*) filter (where property_id = '00000000-0000-0000-0000-0000000e85a2') = 0)::int as acotado_deberia_ser_1 from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30');
rollback;

\echo '=== B9. RECHAZADO: limites de p_dias (13, 366, null) y p_hasta nulo -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
do $$
begin
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-30', 13)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-30', 366)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-30', null)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, null)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', array[]::uuid[], date '2026-06-30')$q$, '22023');
end $$;
select 1 as limites_ok;
rollback;

\echo '=== B10. los extremos exactos (14 y 365 dias) se aceptan ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select ((select count(*) from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-30', 14)) = 3 and (select count(*) from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-30', 365)) = 3)::int as extremos_deberia_ser_1;
rollback;

-- ===========================================================================
-- C. cfo_pedidos_detalle con es_venta
-- ===========================================================================
\echo '=== C1. contrato de columnas: las 19 de la 081 en el mismo orden y es_venta al final ==='
begin;
select ((select array_agg(n order by o) from unnest((select p.proargnames from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'restaurantes' and p.proname = 'cfo_pedidos_detalle'),
                                                    (select p.proargmodes from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'restaurantes' and p.proname = 'cfo_pedidos_detalle')) with ordinality as t(n, m, o) where m = 't')
       = array['order_id','order_number','property_id','dia_negocio','hora_local','canal','source','status','payment_method','bruta','desc','neta','propina','entregado_min','es_compensacion','es_reposicion','cliente_alias','comanda_estado','cursor_pagina','es_venta']::text[])::int as columnas_deberia_ser_1;
rollback;

\echo '=== C2. es_venta viaja en cada fila y coincide con el estado: 31 ventas (entregado y completado) y 3 no ventas (cancelado, falso, por_aprobar) en H4 de 06-01 a 06-30 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (count(*) = 34 and count(*) filter (where es_venta) = 31 and count(*) filter (where not es_venta) = 3
        and count(*) filter (where not es_venta and status in ('cancelado', 'por_aprobar')) = 2
        and count(*) filter (where status = 'completado' and es_venta) = 10 and count(*) filter (where status = 'entregado' and es_venta) = 21)::int as es_venta_deberia_ser_1
  from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-01', date '2026-06-30', null, 200);
rollback;

\echo '=== C3. el filtro es_venta sigue funcionando: true = 31 y false = 3 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select ((select count(*) from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-01', date '2026-06-30', '{"es_venta": true}'::jsonb, 200)) = 31
    and (select count(*) from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-01', date '2026-06-30', '{"es_venta": false}'::jsonb, 200) where not es_venta) = 3)::int as filtro_deberia_ser_1;
rollback;

\echo '=== C4. el pedido falso es es_venta = false y el cancelado tambien; el de bruta 0 sigue siendo venta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (count(*) = 3 and (array_agg(es_venta order by dia_negocio))= array[false, true, false])::int as estados_deberia_ser_1
  from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', array['00000000-0000-0000-0000-0000000e85d1']::uuid[], date '2026-06-25', date '2026-06-27', null, 200);
rollback;

\echo '=== C5. cursor y limite intactos: pagina de 5, cursor_pagina de la ultima fila da las 5 siguientes sin repetir ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
with p1 as (select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-01', date '2026-06-30', null, 5)),
     cur as (select x.cursor_pagina from p1 x order by x.dia_negocio asc, x.order_number asc limit 1),
     p2 as (select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-01', date '2026-06-30', null, 5, (select cursor_pagina from cur)))
select ((select count(*) from p1) = 5 and (select count(*) from p2) = 5 and not exists (select 1 from p1 join p2 using (order_id)))::int as cursor_deberia_ser_1;
rollback;

\echo '=== C6. sin PII: el alias del cliente es de 8 caracteres hex o nulo (H4 no tiene cliente: todo nulo) y nada de nombre ni telefono ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select count(*)::int as alias_malos_deberia_ser_0 from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8501', null, date '2026-04-01', date '2026-06-30', null, 200) where cliente_alias is not null and cliente_alias !~ '^[0-9a-f]{8}$';
rollback;

\echo '=== C7. datos vacios: organizacion sin pedidos devuelve 0 filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select count(*)::int as vacio_deberia_ser_0 from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8505', null, date '2026-06-01', date '2026-06-30', null, 200);
rollback;

\echo '=== C8. RECHAZADO: filtro desconocido y rango de 401 dias -> 22023; staff -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
do $$
begin
  perform public.t_esperar_error($q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-01', date '2026-06-30', '{"telefono": "x"}'::jsonb)$q$, '22023');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8504', null, date '2025-05-01', date '2026-06-30')$q$, '22023');
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8513', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-01', date '2026-06-30')$q$, '42501') as rechazo_ok;
rollback;

-- ===========================================================================
-- D. sr_resumen_leer con forma_pago
-- ===========================================================================
\echo '=== D1. contrato de columnas: las 10 de la 083 en el mismo orden y forma_pago al final ==='
begin;
select ((select array_agg(n order by o) from unnest((select p.proargnames from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'restaurantes' and p.proname = 'sr_resumen_leer'),
                                                    (select p.proargmodes from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'restaurantes' and p.proname = 'sr_resumen_leer')) with ordinality as t(n, m, o) where m = 't')
       = array['property_id','dia_negocio','tipo_servicio','tickets','bruta_centavos','descuento_centavos','cancelado_centavos','propina_centavos','iva_centavos','neta_centavos','forma_pago']::text[])::int as columnas_deberia_ser_1;
rollback;

\echo '=== D2. owner: 5 renglones (4 de P1 partidos por forma de pago y 1 de P2) con la forma en minusculas y NULL cuando el archivo no la trae ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (count(*) = 5
        and count(*) filter (where property_id = '00000000-0000-0000-0000-0000000e85a1' and dia_negocio = date '2026-03-10' and tipo_servicio = 'comedor' and forma_pago = 'efectivo' and tickets = 10 and neta_centavos = 95000 and iva_centavos = 13103) = 1
        and count(*) filter (where property_id = '00000000-0000-0000-0000-0000000e85a1' and dia_negocio = date '2026-03-10' and tipo_servicio = 'comedor' and forma_pago = 'tarjeta' and tickets = 5 and neta_centavos = 50000 and propina_centavos = 4000) = 1
        and count(*) filter (where property_id = '00000000-0000-0000-0000-0000000e85a1' and tipo_servicio = 'domicilio' and forma_pago is null and iva_centavos is null and neta_centavos = 9000) = 1
        and count(*) filter (where dia_negocio = date '2026-03-11' and forma_pago = 'tarjeta' and neta_centavos = 20000) = 1
        and count(*) filter (where property_id = '00000000-0000-0000-0000-0000000e85a2') = 1)::int as renglones_deberia_ser_1
  from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', null, date '2026-03-10', date '2026-03-11');
rollback;

\echo '=== D3. la suma por (sucursal, dia, servicio) es IDENTICA a lo que devolvia la 083 (todas las formas de pago sumadas): comedor 03-10 = 15 tickets, 150000 bruta, 145000 neta, 12000 propina, iva 19999 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (sum(tickets) = 15 and sum(bruta_centavos) = 150000 and sum(descuento_centavos) = 5000 and sum(cancelado_centavos) = 2000 and sum(neta_centavos) = 145000
        and sum(propina_centavos) = 12000 and sum(iva_centavos) = 19999)::int as suma_deberia_ser_1
  from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-03-10', date '2026-03-10') where tipo_servicio = 'comedor';
rollback;

\echo '=== D4. aditividad contra la tabla: Σ tickets y neta de la funcion == Σ de sr_resumen_dia vigente en el rango, por sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select count(*)::int as diferencias_deberia_ser_0 from (
  select f.property_id, sum(f.tickets) t, sum(f.neta_centavos) n from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', null, date '2026-03-10', date '2026-03-11') f group by f.property_id
  except
  select r.property_id, sum(r.tickets), sum(r.neta_centavos) from restaurantes.sr_resumen_dia r where r.organization_id = '00000000-0000-0000-0000-0000000e8501' and r.estado = 'vigente' and r.dia_negocio between date '2026-03-10' and date '2026-03-11' group by r.property_id
) d;
rollback;

\echo '=== D5. orden estable: dia, servicio y forma de pago (nulos primero) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select (array_agg(coalesce(forma_pago, '-')) = array['efectivo', 'tarjeta', '-', 'tarjeta']::text[])::int as orden_deberia_ser_1
  from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-03-10', date '2026-03-11');
rollback;

\echo '=== D6. admin acotado: solo P1 (4 renglones), nunca P2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8512', true);
select (count(*) = 4 and count(*) filter (where property_id = '00000000-0000-0000-0000-0000000e85a2') = 0)::int as acotado_deberia_ser_1 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', null, date '2026-03-10', date '2026-03-11');
rollback;

\echo '=== D7. RECHAZADO: admin acotado pide P2 -> 42501; staff -> 42501; owner ajeno -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8512', true);
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a2']::uuid[], date '2026-03-10', date '2026-03-11')$q$, '42501') as rechazo_ok;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8513', true);
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', null, date '2026-03-10', date '2026-03-11')$q$, '42501') as rechazo_ok;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8515', true);
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', null, date '2026-03-10', date '2026-03-11')$q$, '42501') as rechazo_ok;
rollback;

\echo '=== D8. datos vacios: rango sin importaciones devuelve 0 filas; rango de 401 dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select count(*)::int as vacio_deberia_ser_0 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', null, date '2026-05-01', date '2026-05-31');
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', null, date '2025-05-01', date '2026-06-30')$q$, '22023') as rechazo_ok;
rollback;

\echo '=== D9. reimportar un archivo con otra forma de pago reemplaza los renglones del dia y la lectura suma solo lo vigente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select aceptados from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8501', '00000000-0000-0000-0000-0000000e85a1', repeat('d', 64), 'resumen_servicio', 'reemplazo.csv', '[
  {"dia_negocio":"2026-03-11","tipo_servicio":"comedor","forma_pago":"efectivo","tickets":4,"bruta_centavos":30000,"neta_centavos":30000}
]'::jsonb);
select (count(*) = 1 and sum(neta_centavos) = 30000 and max(forma_pago) = 'efectivo')::int as vigente_deberia_ser_1
  from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a1']::uuid[], date '2026-03-11', date '2026-03-11');
rollback;

-- ===========================================================================
-- E. Volumen
-- ===========================================================================
\echo '=== E1. volumen (6 000 pedidos, 1 500 clientes, 3 sucursales): frecuentes dormidos = 1 500 (500 por sucursal), p90 = 10.00 y cada llamada < 3 s ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
do $$
declare
  t0 timestamptz;
  n integer;
begin
  t0 := clock_timestamp();
  select frecuentes_dormidos into n from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8506', null, date '2026-06-30', 3, 90, 30, 50) where alcance = 'conjunto';
  if n <> 1500 then raise exception 'frecuentes dormidos del conjunto: % (se esperaban 1500)', n; end if;
  if clock_timestamp() - t0 > interval '3 seconds' then raise exception 'frecuentes dormidos demasiado lento: %', clock_timestamp() - t0; end if;
  select count(*) into n from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8506', null, date '2026-06-30', 3, 90, 30) where alcance = 'sucursal' and frecuentes_dormidos = 500 and pedidos_ventana = 2000;
  if n <> 3 then raise exception 'sucursales con 500 dormidos: % (se esperaban 3)', n; end if;
  t0 := clock_timestamp();
  select count(*) into n from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8506', null, date '2026-06-30', 90) where p90_pct = 10.00 and dias_con_venta >= 14;
  if n <> 4 then raise exception 'p90 de volumen: % renglones con 10.00 (se esperaban 4)', n; end if;
  if clock_timestamp() - t0 > interval '3 seconds' then raise exception 'p90 demasiado lento: %', clock_timestamp() - t0; end if;
  t0 := clock_timestamp();
  select count(*) into n from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8506', null, date '2026-04-01', date '2026-06-30', '{"es_venta": true}'::jsonb, 200);
  if n <> 200 then raise exception 'detalle de volumen: % filas (se esperaban 200)', n; end if;
  if clock_timestamp() - t0 > interval '3 seconds' then raise exception 'detalle demasiado lento: %', clock_timestamp() - t0; end if;
end $$;
select 1 as volumen_ok;
rollback;

-- ===========================================================================
-- F. Postura (grants, definer, search_path, volatilidad, comentarios, PII, idempotencia, base sin migrar)
-- ===========================================================================
\echo '=== F1. grants: las 4 funciones solo para authenticated (anon y public sin execute) ==='
begin;
select count(*)::int as grants_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes'
  and p.proname in ('cfo_clientes_frecuentes_dormidos', 'cfo_descuento_p90', 'cfo_pedidos_detalle', 'sr_resumen_leer')
  and (not has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));
rollback;

\echo '=== F2. exactamente 1 definicion (sin sobrecargas) de cada una de las 4 y de cfo_validar_rango (no se redefine) ==='
begin;
select count(*)::int as funciones_deberia_ser_5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes'
  and p.proname in ('cfo_clientes_frecuentes_dormidos', 'cfo_descuento_p90', 'cfo_pedidos_detalle', 'sr_resumen_leer', 'cfo_validar_rango');
rollback;

\echo '=== F3. SECURITY DEFINER y search_path fijo (restaurantes, core, pg_temp): 0 funciones mal ==='
begin;
select count(*)::int as postura_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes'
  and p.proname in ('cfo_clientes_frecuentes_dormidos', 'cfo_descuento_p90', 'cfo_pedidos_detalle', 'sr_resumen_leer')
  and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=restaurantes, core, pg_temp'));
rollback;

\echo '=== F4. search_path=0 sin fijar en TODA funcion SECURITY DEFINER de la 084 (las 4) ==='
begin;
select count(*)::int as sin_search_path_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes'
  and p.proname in ('cfo_clientes_frecuentes_dormidos', 'cfo_descuento_p90', 'cfo_pedidos_detalle', 'sr_resumen_leer')
  and p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%');
rollback;

\echo '=== F5. las 4 son STABLE (solo lectura) y tienen COMMENT ==='
begin;
select count(*)::int as mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes'
  and p.proname in ('cfo_clientes_frecuentes_dormidos', 'cfo_descuento_p90', 'cfo_pedidos_detalle', 'sr_resumen_leer')
  and (p.provolatile <> 's' or obj_description(p.oid, 'pg_proc') is null);
rollback;

\echo '=== F6. corren en transaccion READ ONLY (no escriben nada) ==='
begin;
set transaction read only;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8511', true);
select count(*)::int as lecturas_deberia_ser_3 from (
  select 1 from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30', null, null, 30, 3) where alcance = 'conjunto'
  union all select 1 from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8504', null, date '2026-06-30', 30) where alcance = 'conjunto'
  union all select 1 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8501', array['00000000-0000-0000-0000-0000000e85a2']::uuid[], date '2026-03-10', date '2026-03-10')
) x;
rollback;

\echo '=== F7. sin PII en las columnas de salida de las 2 funciones nuevas (la muestra solo lleva alias hash) ==='
begin;
select count(*)::int as pii_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(p.proargnames, p.proargmodes) as a(nm, m)
 where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_frecuentes_dormidos', 'cfo_descuento_p90')
   and a.nm ~* '(nombre|name|telefono|phone|email|correo|direccion|address|customer|cliente_id)';
rollback;

\echo '=== F8. idempotencia: re-ejecutar las definiciones de las 4 no cambia nada (mismo md5, mismos grants) ==='
begin;
do $$
declare
  r record;
  v_antes text;
  v_despues text;
begin
  select string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text) into v_antes from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_frecuentes_dormidos', 'cfo_descuento_p90', 'cfo_pedidos_detalle', 'sr_resumen_leer');
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_frecuentes_dormidos', 'cfo_descuento_p90', 'cfo_pedidos_detalle', 'sr_resumen_leer') loop
    execute pg_get_functiondef(r.oid);
  end loop;
  select string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text) into v_despues from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_frecuentes_dormidos', 'cfo_descuento_p90', 'cfo_pedidos_detalle', 'sr_resumen_leer');
  if v_antes is distinct from v_despues then
    raise exception 'la re-ejecucion cambio las funciones o sus permisos';
  end if;
end $$;
select 1 as idempotente_ok;
rollback;

\echo '=== F9. la 084 no abre helpers de la 081/082/083: siguen cerrados a authenticated; las publicas de esas migraciones siguen abiertas ==='
begin;
select count(*)::int as postura_previa_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes'
  and ((p.proname in ('cfo_pedidos_base', 'cfo_resolver_sucursales', 'cfo_renglones', 'cfo_validar_rango', 'cfo_venta_lean', 'cfo_zonas', 'cfo_resolver_alcance', 'cfo_config_efectiva') and has_function_privilege('authenticated', p.oid, 'execute'))
    or (p.proname in ('cfo_ventas_diarias', 'cfo_clientes_resumen', 'cfo_agotados', 'sr_lotes_listar', 'sr_cobertura', 'cfo_config_leer') and not has_function_privilege('authenticated', p.oid, 'execute')));
rollback;

\echo '=== F10. base SIN migrar: las funciones nuevas eliminadas dan 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.cfo_clientes_frecuentes_dormidos(uuid, uuid[], date, integer, integer, integer, integer);
drop function restaurantes.cfo_descuento_p90(uuid, uuid[], date, integer);
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.cfo_clientes_frecuentes_dormidos('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30');
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
  begin
    perform * from restaurantes.cfo_descuento_p90('00000000-0000-0000-0000-0000000e8501', null, date '2026-06-30');
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo 'Todos los escenarios terminan con la expectativa del propio archivo: RECHAZADO = sin ERROR dentro de t_esperar_error (el helper exige el SQLSTATE exacto); alias deberia_ser_N = valor exacto.'
