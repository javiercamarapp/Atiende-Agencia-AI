-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales, rol `authenticated`) de
-- packages/domain-restaurantes/migrations/082_cfo_clientes_agente_operacion.sql: funciones restaurantes.cfo_* de clientes, agente, operacion,
-- colonias, comandas del POS y agotados del modulo CFO. (Generado a mano a partir de un corpus pequeno cuyos valores se calcularon a mano.)
--
-- Corpus (organizacion A: A1 Mexico con corte 01:00, A2 Mexico sin corte, A3 Auckland; B: ajena; C: concentracion; D: mediana; E: cohortes):
--   A. Clientes (marzo 2026, A1/A2): 15 clientes con bordes de activo/dormido/perdido (60/61, 120/121), frecuente (3 en 90 dias si, 2 no; el pedido del
--      dia 90 no cuenta), nuevo/recurrente, multi-sucursal, recuperado con envio de campana 13 dias antes (si) y 15 (no), ruido que NO cuenta (cancelado,
--      falso, demo, programado, por_aprobar). C: top 10 % con 10 clientes. D: mediana de dias entre pedidos. E: cohortes con recompra 30/60/90.
--   B. Agente (10-11 abril, A2/A1/A3): embudo de WhatsApp (demo fuera) y voz (preview fuera), costos contra voz_kpis_diarios, categoria 'voz' NO sumada,
--      fila «No asignado» solo para organizacion completa, sin fx_rate => centavos nulos, 0 eventos de Meta => costo nulo.
--   C. Operacion: entregas, percentiles, repartidores, colonias (k-anonimato), comandas del POS (todos los estados) y agotados.
--   D. Aditividad: consolidado == union de sucursales (+ «No asignado»); multi-sucursal == Σ sucursales − conjunto.
--   E. Seguridad: owner, admin sin acotar, admin acotado, staff, repartidor, otra organizacion, anon, sistema cruzando organizaciones.
--   F. Rendimiento (20 000 pedidos), grants, SECURITY DEFINER, STABLE, search_path, sin PII, idempotencia, base sin migrar.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el que debe terminar en ERROR; los alias
-- con sufijo deberia_ser_N marcan el valor esperado.
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

-- Inserta un pedido en la hora LOCAL indicada. p_entrega_min = minutos hasta delivered_at.
create or replace function public.t_ped(p_org uuid, p_prop uuid, p_cust uuid, p_dia date, p_hora time, p_total numeric, p_status text default 'entregado',
  p_canal text default 'recoger', p_addr text default null, p_phone text default null, p_entrega_min integer default null, p_rep uuid default null,
  p_note text default null, p_id uuid default gen_random_uuid(), p_tz text default 'America/Mexico_City', p_items jsonb default '[]'::jsonb) returns uuid
language plpgsql as $$
declare
  v_ts timestamptz := (p_dia + p_hora) at time zone p_tz;
begin
  insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, total, status, items, source,
                                   canal, created_at, delivered_at, assigned_repartidor_id, incident_note, programado_para)
  values (p_id, p_org, p_prop, p_cust, 'Cliente', coalesce(p_phone, '+52 5500000000'), p_addr, p_total, p_status, p_items, 'whatsapp', p_canal, v_ts,
          case when p_entrega_min is null then null else v_ts + p_entrega_min * interval '1 minute' end, p_rep, p_note,
          case when p_status = 'programado' then v_ts + interval '5 days' end);
  return p_id;
end $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e4401', 'restaurantes', 'CFO2 Org A', 'cfo2-a'),
  ('00000000-0000-0000-0000-0000000e4402', 'restaurantes', 'CFO2 Org B', 'cfo2-b'),
  ('00000000-0000-0000-0000-0000000e4403', 'restaurantes', 'CFO2 Org C', 'cfo2-c'),
  ('00000000-0000-0000-0000-0000000e4404', 'restaurantes', 'CFO2 Org D', 'cfo2-d'),
  ('00000000-0000-0000-0000-0000000e4405', 'restaurantes', 'CFO2 Org E', 'cfo2-e'),
  ('00000000-0000-0000-0000-0000000e4406', 'restaurantes', 'CFO2 Org F', 'cfo2-f'),
  ('00000000-0000-0000-0000-0000000e4407', 'restaurantes', 'CFO2 Org G', 'cfo2-g')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e44a1', '00000000-0000-0000-0000-0000000e4401', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4401', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e44a3', '00000000-0000-0000-0000-0000000e4401', 'Sucursal A3'),
  ('00000000-0000-0000-0000-0000000e44b1', '00000000-0000-0000-0000-0000000e4402', 'Sucursal B1'),
  ('00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4403', 'Sucursal C1'),
  ('00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4404', 'Sucursal D1'),
  ('00000000-0000-0000-0000-0000000e44e1', '00000000-0000-0000-0000-0000000e4405', 'Sucursal E1'),
  ('00000000-0000-0000-0000-0000000e44f1', '00000000-0000-0000-0000-0000000e4406', 'Sucursal F1'),
  ('00000000-0000-0000-0000-0000000e44d2', '00000000-0000-0000-0000-0000000e4407', 'Sucursal G1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria, lat, lng) values
  ('00000000-0000-0000-0000-0000000e44a1', '00000000-0000-0000-0000-0000000e4401', 'a1', null, 21.5, -90.0),
  ('00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4401', 'a2', null, 20.97, -89.62),
  ('00000000-0000-0000-0000-0000000e44a3', '00000000-0000-0000-0000-0000000e4401', 'a3', 'Pacific/Auckland', null, null),
  ('00000000-0000-0000-0000-0000000e44b1', '00000000-0000-0000-0000-0000000e4402', 'b1', null, null, null),
  ('00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4403', 'c1', null, null, null),
  ('00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4404', 'd1', null, null, null),
  ('00000000-0000-0000-0000-0000000e44e1', '00000000-0000-0000-0000-0000000e4405', 'e1', null, null, null),
  ('00000000-0000-0000-0000-0000000e44f1', '00000000-0000-0000-0000-0000000e4406', 'f1', null, null, null),
  ('00000000-0000-0000-0000-0000000e44d2', '00000000-0000-0000-0000-0000000e4407', 'g1', null, null, null)
on conflict do nothing;
-- Turno 12:00 -> 01:00 en A1: corte de 1 h.
insert into restaurantes.branch_policy (property_id, organization_id, horario) values
  ('00000000-0000-0000-0000-0000000e44a1', '00000000-0000-0000-0000-0000000e4401', '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]');
insert into restaurantes.known_zone (organization_id, name, lat, lng) values ('00000000-0000-0000-0000-0000000e4401', 'Centro', 20.97, -89.62);

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e4411', 'owner-a@cfo2.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4412', 'admin-a1@cfo2.example.com', 'Admin A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e4413', 'staff-a@cfo2.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4414', 'rep-a@cfo2.example.com', 'Repartidor Sin Entregas', 'seed'),
  ('00000000-0000-0000-0000-0000000e4415', 'owner-b@cfo2.example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-0000000e4416', 'rep1@cfo2.example.com', 'Repartidor Uno', 'seed'),
  ('00000000-0000-0000-0000-0000000e4417', 'rep2@cfo2.example.com', 'Repartidor Dos', 'seed'),
  ('00000000-0000-0000-0000-0000000e4418', 'repb@cfo2.example.com', 'Repartidor de B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e4411', '00000000-0000-0000-0000-0000000e4401', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4412', '00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e4413', '00000000-0000-0000-0000-0000000e4401', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e4414', '00000000-0000-0000-0000-0000000e4401', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e4415', '00000000-0000-0000-0000-0000000e4402', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4416', '00000000-0000-0000-0000-0000000e4401', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e4417', '00000000-0000-0000-0000-0000000e4401', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e4418', '00000000-0000-0000-0000-0000000e4402', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e4411', '00000000-0000-0000-0000-0000000e4403', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4411', '00000000-0000-0000-0000-0000000e4404', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4411', '00000000-0000-0000-0000-0000000e4405', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4411', '00000000-0000-0000-0000-0000000e4406', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4411', '00000000-0000-0000-0000-0000000e4407', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.categories (id, organization_id, name, slug) values ('00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4401', 'Tacos', 'tacos');
insert into restaurantes.products (id, organization_id, category_id, name, price) values
  ('00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44d1', 'Taco al pastor', 50.00),
  ('00000000-0000-0000-0000-0000000e44c2', '00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44d1', 'Refresco', 20.00);

insert into restaurantes.customers (id, organization_id, phone, name) values
  ('00000000-0000-0000-0000-0000000e4501', '00000000-0000-0000-0000-0000000e4401', '+52 5500000001', 'c1'),
  ('00000000-0000-0000-0000-0000000e4502', '00000000-0000-0000-0000-0000000e4401', '+52 5500000002', 'c2'),
  ('00000000-0000-0000-0000-0000000e4503', '00000000-0000-0000-0000-0000000e4401', '+52 5500000003', 'c3'),
  ('00000000-0000-0000-0000-0000000e4504', '00000000-0000-0000-0000-0000000e4401', '+52 5500000004', 'c4'),
  ('00000000-0000-0000-0000-0000000e4505', '00000000-0000-0000-0000-0000000e4401', '+52 5500000005', 'c5'),
  ('00000000-0000-0000-0000-0000000e4506', '00000000-0000-0000-0000-0000000e4401', '+52 5500000006', 'c6'),
  ('00000000-0000-0000-0000-0000000e4507', '00000000-0000-0000-0000-0000000e4401', '+52 5500000007', 'c7'),
  ('00000000-0000-0000-0000-0000000e4508', '00000000-0000-0000-0000-0000000e4401', '+52 5500000008', 'c8'),
  ('00000000-0000-0000-0000-0000000e4509', '00000000-0000-0000-0000-0000000e4401', '+52 5500000009', 'c9'),
  ('00000000-0000-0000-0000-0000000e450a', '00000000-0000-0000-0000-0000000e4401', '+52 5500000010', 'c10'),
  ('00000000-0000-0000-0000-0000000e450b', '00000000-0000-0000-0000-0000000e4401', '+52 5500000011', 'c11'),
  ('00000000-0000-0000-0000-0000000e450c', '00000000-0000-0000-0000-0000000e4401', '+52 5500000012', 'c12'),
  ('00000000-0000-0000-0000-0000000e450d', '00000000-0000-0000-0000-0000000e4401', '+52 5500000013', 'c13'),
  ('00000000-0000-0000-0000-0000000e450e', '00000000-0000-0000-0000-0000000e4401', '+52 5500000014', 'c14'),
  ('00000000-0000-0000-0000-0000000e450f', '00000000-0000-0000-0000-0000000e4401', '+52 5500000015', 'c15'),
  ('00000000-0000-0000-0000-0000000e4521', '00000000-0000-0000-0000-0000000e4401', '+52 5500000033', 'k1'),
  ('00000000-0000-0000-0000-0000000e4522', '00000000-0000-0000-0000-0000000e4401', '+52 5500000034', 'k2'),
  ('00000000-0000-0000-0000-0000000e4523', '00000000-0000-0000-0000-0000000e4401', '+52 5500000035', 'k3'),
  ('00000000-0000-0000-0000-0000000e4524', '00000000-0000-0000-0000-0000000e4401', '+52 5500000036', 'k4'),
  ('00000000-0000-0000-0000-0000000e4525', '00000000-0000-0000-0000-0000000e4401', '+52 5500000037', 'k5'),
  ('00000000-0000-0000-0000-0000000e4526', '00000000-0000-0000-0000-0000000e4401', '+52 5500000038', 'k6'),
  ('00000000-0000-0000-0000-0000000e4527', '00000000-0000-0000-0000-0000000e4401', '+52 5500000039', 'k7'),
  ('00000000-0000-0000-0000-0000000e4528', '00000000-0000-0000-0000-0000000e4401', '+52 5500000040', 'k8'),
  ('00000000-0000-0000-0000-0000000e4529', '00000000-0000-0000-0000-0000000e4401', '+52 5500000041', 'k9'),
  ('00000000-0000-0000-0000-0000000e452a', '00000000-0000-0000-0000-0000000e4401', '+52 5500000042', 'k10'),
  ('00000000-0000-0000-0000-0000000e452b', '00000000-0000-0000-0000-0000000e4401', '+52 5500000043', 'k11'),
  ('00000000-0000-0000-0000-0000000e452c', '00000000-0000-0000-0000-0000000e4401', '+52 5500000044', 'k12'),
  ('00000000-0000-0000-0000-0000000e452d', '00000000-0000-0000-0000-0000000e4401', '+52 5500000045', 'k13'),
  ('00000000-0000-0000-0000-0000000e4541', '00000000-0000-0000-0000-0000000e4403', '+52 5500000065', 'x1'),
  ('00000000-0000-0000-0000-0000000e4542', '00000000-0000-0000-0000-0000000e4403', '+52 5500000066', 'x2'),
  ('00000000-0000-0000-0000-0000000e4543', '00000000-0000-0000-0000-0000000e4403', '+52 5500000067', 'x3'),
  ('00000000-0000-0000-0000-0000000e4544', '00000000-0000-0000-0000-0000000e4403', '+52 5500000068', 'x4'),
  ('00000000-0000-0000-0000-0000000e4545', '00000000-0000-0000-0000-0000000e4403', '+52 5500000069', 'x5'),
  ('00000000-0000-0000-0000-0000000e4546', '00000000-0000-0000-0000-0000000e4403', '+52 5500000070', 'x6'),
  ('00000000-0000-0000-0000-0000000e4547', '00000000-0000-0000-0000-0000000e4403', '+52 5500000071', 'x7'),
  ('00000000-0000-0000-0000-0000000e4548', '00000000-0000-0000-0000-0000000e4403', '+52 5500000072', 'x8'),
  ('00000000-0000-0000-0000-0000000e4549', '00000000-0000-0000-0000-0000000e4403', '+52 5500000073', 'x9'),
  ('00000000-0000-0000-0000-0000000e454a', '00000000-0000-0000-0000-0000000e4403', '+52 5500000074', 'x10'),
  ('00000000-0000-0000-0000-0000000e4561', '00000000-0000-0000-0000-0000000e4404', '+52 5500000097', 'y1'),
  ('00000000-0000-0000-0000-0000000e4562', '00000000-0000-0000-0000-0000000e4404', '+52 5500000098', 'y2'),
  ('00000000-0000-0000-0000-0000000e4563', '00000000-0000-0000-0000-0000000e4404', '+52 5500000099', 'y3'),
  ('00000000-0000-0000-0000-0000000e4581', '00000000-0000-0000-0000-0000000e4405', '+52 5500000129', 'q1'),
  ('00000000-0000-0000-0000-0000000e4582', '00000000-0000-0000-0000-0000000e4405', '+52 5500000130', 'q2'),
  ('00000000-0000-0000-0000-0000000e4583', '00000000-0000-0000-0000-0000000e4405', '+52 5500000131', 'q3'),
  ('00000000-0000-0000-0000-0000000e4584', '00000000-0000-0000-0000-0000000e4405', '+52 5500000132', 'q4'),
  ('00000000-0000-0000-0000-0000000e4585', '00000000-0000-0000-0000-0000000e4405', '+52 5500000133', 'q5'),
  ('00000000-0000-0000-0000-0000000e45a1', '00000000-0000-0000-0000-0000000e4406', '+52 5500000161', 'f1'),
  ('00000000-0000-0000-0000-0000000e45a2', '00000000-0000-0000-0000-0000000e4406', '+52 5500000162', 'f2'),
  ('00000000-0000-0000-0000-0000000e45a3', '00000000-0000-0000-0000-0000000e4406', '+52 5500000163', 'f3'),
  ('00000000-0000-0000-0000-0000000e45a4', '00000000-0000-0000-0000-0000000e4406', '+52 5500000164', 'f4'),
  ('00000000-0000-0000-0000-0000000e45c1', '00000000-0000-0000-0000-0000000e4407', '+52 5500000193', 'g1'),
  ('00000000-0000-0000-0000-0000000e45c2', '00000000-0000-0000-0000-0000000e4407', '+52 5500000194', 'g2'),
  ('00000000-0000-0000-0000-0000000e45c3', '00000000-0000-0000-0000-0000000e4407', '+52 5500000195', 'g3'),
  ('00000000-0000-0000-0000-0000000e45c4', '00000000-0000-0000-0000-0000000e4407', '+52 5500000196', 'g4'),
  ('00000000-0000-0000-0000-0000000e45c5', '00000000-0000-0000-0000-0000000e4407', '+52 5500000197', 'g5');

-- Clientes (A): ver comentario de cabecera.
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4501', date '2026-03-10', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4502', date '2026-02-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4502', date '2026-03-12', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4503', date '2026-01-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4503', date '2026-02-10', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4503', date '2026-03-20', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4504', date '2025-12-31', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4504', date '2026-02-15', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4504', date '2026-03-15', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a1', '00000000-0000-0000-0000-0000000e4505', date '2026-03-05', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4505', date '2026-03-06', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4506', date '2026-03-02', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4507', date '2026-01-20', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4508', date '2025-10-15', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4509', date '2026-01-30', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e450a', date '2026-01-29', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e450b', date '2025-12-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e450c', date '2025-11-30', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e450d', date '2025-12-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e450d', date '2026-03-15', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e450e', date '2025-12-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e450e', date '2026-03-20', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e450f', date '2026-02-20', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e450f', date '2026-03-22', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4501', date '2026-03-11', time '15:00', 50, p_status => 'cancelado');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4503', date '2026-03-16', time '15:00', 70, p_phone => '+52 0009000009');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4501', date '2026-03-17', time '15:00', 70, p_status => 'por_aprobar');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4506', date '2026-03-14', time '15:00', 70, p_status => 'programado');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4502', date '2026-03-13', time '15:00', 70, p_id => '00000000-0000-0000-0000-00000e4f0090');
update restaurantes.orders set pedido_falso_at = now() where id = '00000000-0000-0000-0000-00000e4f0090';
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-03-18', time '15:00', 100);
insert into restaurantes.marketing_campana (id, organization_id, segmento, dias_min, dias_max, dia, estado, promo_nombre, promo_codigo, conteo)
values ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4401', 'inactivo_60', 60, 90, date '2026-03-01', 'aprobada', 'Promo', 'PROMO', 2);
insert into restaurantes.marketing_campana_envio (campana_id, organization_id, customer_id, estado, created_at) values
  ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e450d', 'encolado', (date '2026-03-15' + time '15:00') at time zone 'America/Mexico_City' - interval '13 days'),
  ('00000000-0000-0000-0000-0000000e4ca1', '00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e450e', 'encolado', (date '2026-03-20' + time '15:00') at time zone 'America/Mexico_City' - interval '15 days');

-- C: 10 clientes con 1000, 900, ..., 100 pesos
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4541', date '2026-03-10', time '15:00', 1000);
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4542', date '2026-03-10', time '15:00', 900);
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4543', date '2026-03-10', time '15:00', 800);
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4544', date '2026-03-10', time '15:00', 700);
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4545', date '2026-03-10', time '15:00', 600);
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4546', date '2026-03-10', time '15:00', 500);
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4547', date '2026-03-10', time '15:00', 400);
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4548', date '2026-03-10', time '15:00', 300);
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e4549', date '2026-03-10', time '15:00', 200);
select public.t_ped('00000000-0000-0000-0000-0000000e4403', '00000000-0000-0000-0000-0000000e44c1', '00000000-0000-0000-0000-0000000e454a', date '2026-03-10', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4404', '00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4561', date '2026-03-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4404', '00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4561', date '2026-03-04', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4404', '00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4561', date '2026-03-10', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4404', '00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4562', date '2026-03-02', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4404', '00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4562', date '2026-03-03', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4404', '00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4563', date '2026-03-05', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4404', '00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4563', date '2026-03-05', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4404', '00000000-0000-0000-0000-0000000e44d1', '00000000-0000-0000-0000-0000000e4563', date '2026-03-09', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4405','00000000-0000-0000-0000-0000000e44e1','00000000-0000-0000-0000-0000000e4581', ((now() at time zone 'America/Mexico_City')::date) - 100, time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4405','00000000-0000-0000-0000-0000000e44e1','00000000-0000-0000-0000-0000000e4582', ((now() at time zone 'America/Mexico_City')::date) - 100, time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4405','00000000-0000-0000-0000-0000000e44e1','00000000-0000-0000-0000-0000000e4583', ((now() at time zone 'America/Mexico_City')::date) - 100, time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4405','00000000-0000-0000-0000-0000000e44e1','00000000-0000-0000-0000-0000000e4584', ((now() at time zone 'America/Mexico_City')::date) - 100, time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4405','00000000-0000-0000-0000-0000000e44e1','00000000-0000-0000-0000-0000000e4581', ((now() at time zone 'America/Mexico_City')::date) - 80, time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4405','00000000-0000-0000-0000-0000000e44e1','00000000-0000-0000-0000-0000000e4582', ((now() at time zone 'America/Mexico_City')::date) - 55, time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4405','00000000-0000-0000-0000-0000000e44e1','00000000-0000-0000-0000-0000000e4583', ((now() at time zone 'America/Mexico_City')::date) - 20, time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4405','00000000-0000-0000-0000-0000000e44e1','00000000-0000-0000-0000-0000000e4584', ((now() at time zone 'America/Mexico_City')::date) - 100, time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4405','00000000-0000-0000-0000-0000000e44e1','00000000-0000-0000-0000-0000000e4585', ((now() at time zone 'America/Mexico_City')::date) - 10, time '15:00', 100);
insert into core.fx_rate (fecha, mxn_por_usd, fuente) values (date '2026-04-01', 18.0, 'verify');
-- Pedidos de operacion (A2, 10 de abril): o1..o9
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-10', time '15:00', 100, p_status => 'entregado', p_canal => 'domicilio', p_addr => 'Calle X 1', p_entrega_min => 30, p_rep => '00000000-0000-0000-0000-0000000e4416', p_id => '00000000-0000-0000-0000-00000e4f0001');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-10', time '15:20', 100, p_status => 'entregado', p_canal => 'domicilio', p_addr => 'Calle X 2', p_entrega_min => 60, p_rep => '00000000-0000-0000-0000-0000000e4416', p_note => 'Entrega problematica', p_id => '00000000-0000-0000-0000-00000e4f0002');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-10', time '16:10', 100, p_status => 'completado', p_canal => 'domicilio', p_addr => 'Calle X 3', p_entrega_min => 40, p_rep => '00000000-0000-0000-0000-0000000e4417', p_id => '00000000-0000-0000-0000-00000e4f0003');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-10', time '16:30', 100, p_status => 'en_camino', p_canal => 'domicilio', p_addr => 'Calle X 4', p_rep => '00000000-0000-0000-0000-0000000e4417', p_id => '00000000-0000-0000-0000-00000e4f0004');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-10', time '17:00', 100, p_status => 'entregado', p_entrega_min => 20, p_id => '00000000-0000-0000-0000-00000e4f0005');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-10', time '17:30', 100, p_status => 'pending', p_id => '00000000-0000-0000-0000-00000e4f0006');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-10', time '17:40', 100, p_status => 'pending', p_id => '00000000-0000-0000-0000-00000e4f0007');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-10', time '15:40', 100, p_status => 'cancelado', p_canal => 'domicilio', p_addr => 'Calle X 8', p_entrega_min => 5, p_rep => '00000000-0000-0000-0000-0000000e4416', p_id => '00000000-0000-0000-0000-00000e4f0008');
select public.t_ped('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-10', time '18:00', 100, p_status => 'entregado', p_canal => 'domicilio', p_addr => 'Calle X 9', p_entrega_min => 10, p_rep => '00000000-0000-0000-0000-0000000e4418', p_id => '00000000-0000-0000-0000-00000e4f0009');
-- WhatsApp: w1 (con pedido o1), w2 (handoff), w3 (2 handoffs), w4 demo (fuera)
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, order_id, created_at) values
  ('00000000-0000-0000-0000-0000000e4d01', '00000000-0000-0000-0000-0000000e4401', '+52 5511000001', '00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-00000e4f0001', (date '2026-04-10' + time '15:00') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4d02', '00000000-0000-0000-0000-0000000e4401', '+52 5511000002', '00000000-0000-0000-0000-0000000e44a2', null, (date '2026-04-10' + time '15:00') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4d03', '00000000-0000-0000-0000-0000000e4401', '+52 5511000003', '00000000-0000-0000-0000-0000000e44a2', null, (date '2026-04-10' + time '15:00') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4d04', '00000000-0000-0000-0000-0000000e4401', '+52 0009000001', '00000000-0000-0000-0000-0000000e44a2', null, (date '2026-04-10' + time '15:00') at time zone 'America/Mexico_City');
insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por, solicitada_at) values
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'whatsapp', '00000000-0000-0000-0000-0000000e4d02', 'cerrada', 'agente', (date '2026-04-10' + time '18:00') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'whatsapp', '00000000-0000-0000-0000-0000000e4d03', 'cerrada', 'agente', (date '2026-04-10' + time '18:10') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'whatsapp', '00000000-0000-0000-0000-0000000e4d03', 'pendiente', 'agente', (date '2026-04-10' + time '18:20') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'whatsapp', '00000000-0000-0000-0000-0000000e4d04', 'pendiente', 'agente', (date '2026-04-10' + time '18:30') at time zone 'America/Mexico_City');

insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, started_at, costo_estimado_micro_usd, resultado) values
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'v1', 'llamada', 'elevenlabs-agents', (date '2026-04-10' + time '16:00') at time zone 'America/Mexico_City', 100000, 'pedido_creado'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'v2', 'llamada', 'elevenlabs-agents', (date '2026-04-10' + time '16:00') at time zone 'America/Mexico_City', 50000, 'escalado'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'v3', 'llamada', 'elevenlabs-agents', (date '2026-04-10' + time '16:00') at time zone 'America/Mexico_City', 30000, 'abandonado'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'v4', 'llamada', 'elevenlabs-agents', (date '2026-04-10' + time '16:00') at time zone 'America/Mexico_City', 10000, null),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'v5', 'preview', 'elevenlabs-agents', (date '2026-04-10' + time '16:00') at time zone 'America/Mexico_City', 999999, null),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a1', 'v6', 'llamada', 'elevenlabs-agents', (date '2026-04-11' + time '00:30') at time zone 'America/Mexico_City', 7000, 'pedido_creado'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a3', 'v7', 'llamada', 'elevenlabs-agents', timestamptz '2026-04-10 20:00+00', 1000, 'pedido_creado');

insert into core.usage_cost_event (organization_id, property_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'restaurantes', (date '2026-04-10' + time '10:00') at time zone 'America/Mexico_City', 'telefonia', 'verify', 'unidad', 1, 20000, 'verify', 'e1'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'restaurantes', (date '2026-04-10' + time '11:00') at time zone 'America/Mexico_City', 'telefonia', 'verify', 'unidad', 1, 5000, 'verify', 'e2'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'restaurantes', (date '2026-04-10' + time '12:00') at time zone 'America/Mexico_City', 'voz', 'verify', 'unidad', 1, 70000, 'verify', 'e3'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'restaurantes', (date '2026-04-11' + time '12:00') at time zone 'America/Mexico_City', 'whatsapp', 'verify', 'unidad', 1, 4000, 'verify', 'e4'),
  ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'restaurantes', (date '2026-03-20' + time '12:00') at time zone 'America/Mexico_City', 'telefonia', 'verify', 'unidad', 1, 9000, 'verify', 'e5'),
  ('00000000-0000-0000-0000-0000000e4401', null, 'restaurantes', (date '2026-04-10' + time '12:00') at time zone 'America/Mexico_City', 'telefonia', 'verify', 'unidad', 1, 3000, 'verify', 'e6'),
  ('00000000-0000-0000-0000-0000000e4401', null, 'restaurantes', (date '2026-04-10' + time '12:00') at time zone 'America/Mexico_City', 'whatsapp', 'verify', 'unidad', 1, 1000, 'verify', 'e7');

insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd) values
  ('00000000-0000-0000-0000-0000000e4401', date '2026-04-10', 'restaurantes', 'restaurantes:whatsapp_agent', 'p', 'm', 'interactive', 300000),
  ('00000000-0000-0000-0000-0000000e4401', date '2026-04-10', 'restaurantes', 'restaurantes:whatsapp_agent_escalated', 'p', 'm', 'interactive', 100000),
  ('00000000-0000-0000-0000-0000000e4401', date '2026-04-10', 'restaurantes', 'restaurantes:data_chat', 'p', 'm', 'interactive', 999);

insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e4401', 'activo');
insert into restaurantes.pos_comanda_outbox (organization_id, property_id, order_id, idempotency_key, estado, modo, payload, folio, capturado_en, nota_captura, creado_en, actualizado_en) values
  ('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-00000e4f0001','k1','confirmada','activo','{}','F-1',null,null, (date '2026-04-10' + time '15:00') at time zone 'America/Mexico_City', (date '2026-04-10' + time '15:03') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-00000e4f0002','k2','capturada_manual','activo','{}',null,(date '2026-04-10' + time '15:28') at time zone 'America/Mexico_City','A-123', (date '2026-04-10' + time '15:20') at time zone 'America/Mexico_City', (date '2026-04-10' + time '15:28') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-00000e4f0003','k3','capturada_manual','activo','{}',null,(date '2026-04-10' + time '16:13') at time zone 'America/Mexico_City','nota mala!', (date '2026-04-10' + time '16:10') at time zone 'America/Mexico_City', (date '2026-04-10' + time '16:13') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-00000e4f0004','k4','fallida','activo','{}',null,null,null, (date '2026-04-10' + time '16:30') at time zone 'America/Mexico_City', (date '2026-04-10' + time '16:31') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-00000e4f0005','k5','captura_manual','activo','{}',null,null,null, (date '2026-04-10' + time '17:00') at time zone 'America/Mexico_City', (date '2026-04-10' + time '17:01') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-00000e4f0006','k6','pendiente','activo','{}',null,null,null, (date '2026-04-10' + time '17:30') at time zone 'America/Mexico_City', (date '2026-04-10' + time '17:30') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-00000e4f0007','k7','enviada','activo','{}',null,null,null, (date '2026-04-10' + time '17:40') at time zone 'America/Mexico_City', (date '2026-04-10' + time '17:40') at time zone 'America/Mexico_City');

-- Colonias A2, 12 de abril. Direccion del pedido con mayusculas y espacios dobles; la guardada, normalizada.
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4521', date '2026-04-12', time '12:00', 100, p_status => 'entregado', p_entrega_min => 30, p_canal => 'domicilio', p_addr => 'CALLE  1 #1');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4522', date '2026-04-12', time '12:00', 100, p_status => 'entregado', p_entrega_min => 50, p_canal => 'domicilio', p_addr => 'CALLE  2 #2');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4523', date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'CALLE  3 #3');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4524', date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'CALLE  4 #4');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4525', date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'CALLE  5 #5');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4526', date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'CALLE  6 #6');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4527', date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'CALLE  7 #7');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4528', date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'CALLE  8 #8');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e4529', date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'CALLE  9 #9');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e452a', date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'CALLE  10 #10');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e452b', date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'CALLE  11 #11');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2', null, date '2026-04-12', time '12:00', 100, p_status => 'pending', p_canal => 'domicilio', p_addr => 'Calle Sola 9');
insert into restaurantes.customer_addresses (customer_id, address, colonia) values
  ('00000000-0000-0000-0000-0000000e4521', 'calle 1 #1', 'Centro'),
  ('00000000-0000-0000-0000-0000000e4522', 'calle 2 #2', 'Centro'),
  ('00000000-0000-0000-0000-0000000e4523', 'calle 3 #3', 'Centro'),
  ('00000000-0000-0000-0000-0000000e4524', 'calle 4 #4', 'Centro'),
  ('00000000-0000-0000-0000-0000000e4525', 'calle 5 #5', 'Centro'),
  ('00000000-0000-0000-0000-0000000e4526', 'calle 6 #6', 'Norte'),
  ('00000000-0000-0000-0000-0000000e4527', 'calle 7 #7', 'Norte'),
  ('00000000-0000-0000-0000-0000000e4528', 'calle 8 #8', 'Norte'),
  ('00000000-0000-0000-0000-0000000e4529', 'calle 9 #9', 'Norte'),
  ('00000000-0000-0000-0000-0000000e452b', 'calle 11 #11', null);

insert into restaurantes.branch_products (property_id, product_id, price, is_available, agotado_hasta) values
  ('00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e44c1', 50.00, false, null),
  ('00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e44c2', 20.00, false, ((now() at time zone 'America/Mexico_City')::date) + 1);
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2', null, ((now() at time zone 'America/Mexico_City')::date) - 3, time '15:00', 100, p_items => '[{"id":"00000000-0000-0000-0000-0000000e44c1","name":"Taco","price":50,"quantity":2}]'::jsonb);
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2', null, ((now() at time zone 'America/Mexico_City')::date) - 10, time '15:00', 100, p_items => '[{"id":"00000000-0000-0000-0000-0000000e44c1","name":"Taco","price":50,"quantity":3}]'::jsonb);
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2', null, ((now() at time zone 'America/Mexico_City')::date) - 40, time '15:00', 100, p_items => '[{"id":"00000000-0000-0000-0000-0000000e44c1","name":"Taco","price":50,"quantity":5}]'::jsonb);
-- F: churn. f1 y f4 solo enero/abril, f2 repite en junio, f3 viejo
select public.t_ped('00000000-0000-0000-0000-0000000e4406', '00000000-0000-0000-0000-0000000e44f1', '00000000-0000-0000-0000-0000000e45a1', date '2026-01-10', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4406', '00000000-0000-0000-0000-0000000e44f1', '00000000-0000-0000-0000-0000000e45a2', date '2026-01-20', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4406', '00000000-0000-0000-0000-0000000e44f1', '00000000-0000-0000-0000-0000000e45a2', date '2026-06-20', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4406', '00000000-0000-0000-0000-0000000e44f1', '00000000-0000-0000-0000-0000000e45a3', date '2025-10-01', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4406', '00000000-0000-0000-0000-0000000e44f1', '00000000-0000-0000-0000-0000000e45a4', date '2026-01-15', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4406', '00000000-0000-0000-0000-0000000e44f1', '00000000-0000-0000-0000-0000000e45a4', date '2026-04-30', time '15:00', 100);
-- G: ventana de perdidos anclada al cierre (2026-06-30): clientes con 100, 400, 800, 150 y 5 dias sin pedir
select public.t_ped('00000000-0000-0000-0000-0000000e4407', '00000000-0000-0000-0000-0000000e44d2', '00000000-0000-0000-0000-0000000e45c1', date '2026-03-22', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4407', '00000000-0000-0000-0000-0000000e44d2', '00000000-0000-0000-0000-0000000e45c2', date '2025-05-26', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4407', '00000000-0000-0000-0000-0000000e44d2', '00000000-0000-0000-0000-0000000e45c3', date '2024-04-21', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4407', '00000000-0000-0000-0000-0000000e44d2', '00000000-0000-0000-0000-0000000e45c4', date '2026-01-31', time '15:00', 100);
select public.t_ped('00000000-0000-0000-0000-0000000e4407', '00000000-0000-0000-0000-0000000e44d2', '00000000-0000-0000-0000-0000000e45c5', date '2026-06-25', time '15:00', 100);
-- Otay (13 de abril): 5 pedidos de UN cliente en una colonia: no se muestra (k de clientes)
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e452c', date '2026-04-13', time '12:00', 100, p_canal => 'domicilio', p_addr => 'Calle Otay 1');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e452c', date '2026-04-13', time '12:01', 100, p_canal => 'domicilio', p_addr => 'Calle Otay 1');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e452c', date '2026-04-13', time '12:02', 100, p_canal => 'domicilio', p_addr => 'Calle Otay 1');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e452c', date '2026-04-13', time '12:03', 100, p_canal => 'domicilio', p_addr => 'Calle Otay 1');
select public.t_ped('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e452c', date '2026-04-13', time '12:04', 100, p_canal => 'domicilio', p_addr => 'Calle Otay 1');
insert into restaurantes.customer_addresses (customer_id, address, colonia) values ('00000000-0000-0000-0000-0000000e452c', 'calle otay 1', 'Otay');
analyze restaurantes.orders;

\echo '=== A1. cfo_venta_lean == cfo_pedidos_base (solo ventas): mismas filas, dia, hora, dow, canal, neta y minutos de entrega (A1+A2+A3, febrero a abril) ==='
begin;
select count(*)::int as diferencias_deberia_ser_0 from (
  (select b.order_id, b.property_id, b.customer_id, b.dia_negocio, b.hora_local, b.dow_negocio, b.canal_efectivo, b.neta_centavos, b.entregado_min
     from restaurantes.cfo_pedidos_base('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-02-01', date '2026-04-30') b where b.es_venta
   except
   select l.order_id, l.property_id, l.customer_id, l.dia_negocio, l.hora_local, l.dow_negocio, l.canal_efectivo, l.neta_centavos, l.entregado_min
     from restaurantes.cfo_venta_lean('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-02-01', date '2026-04-30') l)
  union all
  (select l.order_id, l.property_id, l.customer_id, l.dia_negocio, l.hora_local, l.dow_negocio, l.canal_efectivo, l.neta_centavos, l.entregado_min
     from restaurantes.cfo_venta_lean('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-02-01', date '2026-04-30') l
   except
   select b.order_id, b.property_id, b.customer_id, b.dia_negocio, b.hora_local, b.dow_negocio, b.canal_efectivo, b.neta_centavos, b.entregado_min
     from restaurantes.cfo_pedidos_base('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-02-01', date '2026-04-30') b where b.es_venta)
) d;
rollback;

\echo '=== A2. cfo_venta_lean cuenta 11 ventas en marzo (A1+A2): sin el cancelado, el demo, el falso, el por_aprobar ni el programado; 10 con cliente y 1 sin cliente ==='
begin;
select (count(*) = 11 and count(*) filter (where customer_id is null) = 1)::int as ventas_deberia_ser_1 from restaurantes.cfo_venta_lean('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-03-01', date '2026-03-31');
rollback;

\echo '=== A3. cfo_zonas == voz_zona_horaria + dia_negocio_corte en cada sucursal (Mexico, corte 01:00, Auckland) ==='
begin;
select count(*)::int as zonas_distintas_deberia_ser_0 from restaurantes.cfo_zonas(array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2','00000000-0000-0000-0000-0000000e44a3']::uuid[]) z where z.tz is distinct from restaurantes.voz_zona_horaria(z.property_id) or z.corte is distinct from restaurantes.dia_negocio_corte(z.property_id);
rollback;

\echo '=== A4. dia de negocio en linea (corte 01:00): el pedido de las 00:30 del dia 11 cuenta en el 10 y el de las 01:05 en el 11 (A1) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a1','x','+52 5500000001',10,'pending','[]','whatsapp',(date '2026-05-11' + time '00:30') at time zone 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e4401','00000000-0000-0000-0000-0000000e44a1','x','+52 5500000001',10,'pending','[]','whatsapp',(date '2026-05-11' + time '01:05') at time zone 'America/Mexico_City');
select count(*)::int as corte_deberia_ser_1 from restaurantes.cfo_venta_lean('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-05-10', date '2026-05-10') where dia_negocio = date '2026-05-10' and hora_local = 0;
rollback;

\echo '=== B1. resumen conjunto (owner): 9 clientes con pedido, 3 nuevos (cN1, cMulti, cAct) y 6 recurrentes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.clientes_con_pedido = 9 and r.nuevos = 3 and r.recurrentes = 6)::int as clientes_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B2. resumen conjunto: activos 10 (incluye el borde de 60 dias), dormidos 3 (61, 70 y 120 dias), perdidos 2 (121 y 167 dias) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.activos = 10 and r.dormidos = 3 and r.perdidos = 2)::int as actividad_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B3. resumen conjunto: 1 frecuente (3 pedidos en 90 dias si; con el tercero un dia fuera de la ventana no) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.frecuentes = 1)::int as frecuentes_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B4. resumen con p_frecuente_n = 2: frecuentes cF3, cF2, cR1, cMulti y rec3 (5) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.frecuentes = 5)::int as frecuentes2_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 2) r where r.alcance = 'conjunto';
rollback;

\echo '=== B5. resumen conjunto: 2 recuperados (rec1, rec2: mas de 60 dias sin pedir al inicio) y 1 por campana (envio 13 dias antes si, 15 dias antes no) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.recuperados = 2 and r.recuperados_por_campana = 1)::int as recuperados_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B6. resumen conjunto: mediana de dias entre pedidos 38 (intervalos 1, 28, 30, 38, 39, 104, 109) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.dias_entre_pedidos_mediana = 38.0)::int as mediana_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B7. resumen conjunto: venta neta de clientes 100000 centavos, top 10 % = 20000 (cMulti, 2 pedidos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.neta_total_centavos = 100000 and r.neta_top10pct_centavos = 20000)::int as concentracion_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B8. resumen conjunto: 1.60 pedidos por cliente en 12 meses (24/15), 10 pedidos con cliente y 1 sin cliente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.pedidos_por_cliente_12m_promedio = 1.60 and r.pedidos_con_cliente = 10 and r.pedidos_sin_cliente = 1)::int as ppc_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B9. resumen A2: 9 clientes, 3 nuevos, 6 recurrentes, 10 activos, 3 dormidos, 2 perdidos, 1 frecuente, 2 recuperados (1 por campana) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.clientes_con_pedido = 9 and r.nuevos = 3 and r.recurrentes = 6 and r.activos = 10 and r.dormidos = 3 and r.perdidos = 2 and r.frecuentes = 1 and r.recuperados = 2 and r.recuperados_por_campana = 1)::int as a2_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== B10. resumen A2: mediana 38.5 (sin el intervalo de cMulti, que compro en dos sucursales), 1.53 pedidos por cliente (23/15), 9 pedidos con cliente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.dias_entre_pedidos_mediana = 38.5 and r.pedidos_por_cliente_12m_promedio = 1.53 and r.pedidos_con_cliente = 9 and r.pedidos_sin_cliente = 1)::int as a2b_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== B11. resumen A1: 1 cliente (cMulti), nuevo en A1, sin mediana, 1.00 pedidos por cliente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.clientes_con_pedido = 1 and r.nuevos = 1 and r.activos = 1 and r.dias_entre_pedidos_mediana is null and r.pedidos_por_cliente_12m_promedio = 1.00)::int as a1_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.property_id = '00000000-0000-0000-0000-0000000e44a1';
rollback;

\echo '=== B12. multi-sucursal: Σ clientes de las sucursales (10) − clientes del conjunto (9) = 1 = multi_sucursal = clientes en varias sucursales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select sum(clientes_con_pedido) from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'sucursal') - (select clientes_con_pedido from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto') = 1 and (select multi_sucursal from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto') = 1 and (select clientes_varias_sucursales from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto') = 1)::int as multi_deberia_ser_1;
rollback;

\echo '=== B13. resumen: 3 renglones de sucursal (null en multi_sucursal) + 1 de conjunto (property_id nulo, multi_sucursal presente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as renglones_deberia_ser_4 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where (r.alcance = 'conjunto') = (r.property_id is null) and (r.alcance = 'conjunto') = (r.multi_sucursal is not null);
rollback;

\echo '=== B14. owner con p_props = [A2]: el conjunto son los 9 clientes de A2 y multi_sucursal 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.clientes_con_pedido = 9 and r.multi_sucursal = 0)::int as solo_a2_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B15. admin acotado a A1: solo ve A1 y su conjunto (2 renglones) y el conjunto tiene 1 cliente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4412', true);
select (count(*) = 2 and bool_and(r.property_id is null or r.property_id = '00000000-0000-0000-0000-0000000e44a1') and max(r.clientes_con_pedido) = 1)::int as acotado_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r;
rollback;

\echo '=== B16. organizacion C: top 10 % de 10 clientes (1000..100 pesos) = 1 cliente = 100000 centavos de 550000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.neta_top10pct_centavos = 100000 and r.neta_total_centavos = 550000)::int as top10_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4403', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B17. organizacion D: mediana 3.5 (intervalos 3, 6, 1, 4; dos pedidos el mismo dia son una sola ocasion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.dias_entre_pedidos_mediana = 3.5)::int as mediana_d_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4404', null, date '2026-03-01', date '2026-03-31') r where r.alcance = 'conjunto';
rollback;

\echo '=== B18. cohortes (E): la cohorte de hace 100 dias tiene 4 clientes y recompra a 30/60/90 de 1/2/3 (repetir el mismo dia no cuenta) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (c.clientes = 4 and c.con_recompra_30 = 1 and c.con_recompra_60 = 2 and c.con_recompra_90 = 3)::int as cohorte_deberia_ser_1 from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4405', null, 6) c where c.property_id is null and c.mes_cohorte = to_char(((now() at time zone 'America/Mexico_City')::date - 100), 'YYYY-MM');
rollback;

\echo '=== B19. cohortes: los 4 de hace 100 dias son observables a 30/60/90; el cliente de hace 10 dias no es observable a 30 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select observables_30 = 4 and observables_60 = 4 and observables_90 = 4 from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4405', null, 6) c where c.property_id is null and c.mes_cohorte = to_char(((now() at time zone 'America/Mexico_City')::date - 100), 'YYYY-MM')) and (select clientes = 1 and observables_30 = 0 from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4405', null, 6) c where c.property_id is null and c.mes_cohorte = to_char(((now() at time zone 'America/Mexico_City')::date - 10), 'YYYY-MM')))::int as observables_deberia_ser_1;
rollback;

\echo '=== B20. cohortes: con una sola sucursal, el renglon de la sucursal es igual al del conjunto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as cohortes_distintas_deberia_ser_0 from ((select mes_cohorte, clientes, con_recompra_30, con_recompra_60, con_recompra_90 from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4405', null, 6) where property_id is null except select mes_cohorte, clientes, con_recompra_30, con_recompra_60, con_recompra_90 from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4405', null, 6) where property_id = '00000000-0000-0000-0000-0000000e44e1') union all (select mes_cohorte, clientes, con_recompra_30, con_recompra_60, con_recompra_90 from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4405', null, 6) where property_id = '00000000-0000-0000-0000-0000000e44e1' except select mes_cohorte, clientes, con_recompra_30, con_recompra_60, con_recompra_90 from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4405', null, 6) where property_id is null)) d;
rollback;

\echo '=== B21. altas conjunto: semana del 2 de marzo 2 (cMulti, cAct), semana del 9 de marzo 1 (cN1); el resto ya existia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select altas from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where property_id is null and semana = date '2026-03-02') = 2 and (select altas from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where property_id is null and semana = date '2026-03-09') = 1 and (select sum(altas) from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where property_id is null) = 3)::int as altas_deberia_ser_1;
rollback;

\echo '=== B22. altas por sucursal: A1 1 (el primer pedido de cMulti en A1) y A2 3 (cAct, cMulti, cN1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select sum(altas) from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where property_id = '00000000-0000-0000-0000-0000000e44a1') = 1 and (select sum(altas) from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where property_id = '00000000-0000-0000-0000-0000000e44a2') = 3)::int as altas_suc_deberia_ser_1;
rollback;

\echo '=== B23. segmento por hora (segmento por cliente y sucursal): pedidos del rango frecuente 1, nuevo 4 (cN1, cMulti x2, cAct), recurrente 5; venta neta 100000 y todo a la hora 15 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select sum(pedidos) from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where segmento = 'frecuente') = 1 and (select sum(pedidos) from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where segmento = 'nuevo') = 4 and (select sum(pedidos) from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where segmento = 'recurrente') = 5 and (select sum(neta_centavos) from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31')) = 100000 and (select count(*) from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where hora_local <> 15) = 0)::int as seg_deberia_ser_1;
rollback;

\echo '=== B24. segmento por hora con p_frecuente_n = 2: 4 pedidos frecuentes (cF3, cF2, cR1, rec3; cMulti tiene 1 pedido en cada sucursal) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (sum(pedidos) = 4)::int as seg2_deberia_ser_1 from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 2) where segmento = 'frecuente';
rollback;

\echo '=== B27. perdidos anclados al cierre: mismo p_hasta con rangos de 1, 30 y 400 dias da los MISMOS activos, dormidos y perdidos (sucursal y conjunto) con los umbrales por omision ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as ventana_deberia_ser_0 from ((select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30') r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-01', date '2026-06-30') r) union all (select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-01', date '2026-06-30') r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30') r) union all (select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30') r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2025-05-27', date '2026-06-30') r) union all (select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2025-05-27', date '2026-06-30') r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30') r)) d;
rollback;

\echo '=== B28. perdidos (umbrales por omision, H = 485): los de 150 y 400 dias; activos 1 (5 dias), dormidos 1 (100 dias); el de 800 queda fuera del horizonte ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.activos = 1 and r.dormidos = 1 and r.perdidos = 2)::int as perdidos120_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30') r where r.alcance = 'conjunto';
rollback;

\echo '=== B29. perdidos con perdido_dias = 365 (H = 730): consistente entre rangos y > 0 (el de 400 dias; el de 800 fuera) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (count(*) = 0 and (select r.perdidos = 1 and r.dormidos = 2 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 365) r where r.alcance = 'conjunto'))::int as perdidos365_deberia_ser_1 from ((select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 365) r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-01', date '2026-06-30', 3, 90, 60, 365) r) union all (select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-01', date '2026-06-30', 3, 90, 60, 365) r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 365) r) union all (select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 365) r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2025-05-27', date '2026-06-30', 3, 90, 60, 365) r) union all (select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2025-05-27', date '2026-06-30', 3, 90, 60, 365) r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 365) r)) d;
rollback;

\echo '=== B30. perdidos con perdido_dias = 730 (H = 1095): consistente entre rangos y > 0 (el de 800 dias) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (count(*) = 0 and (select r.perdidos = 1 and r.dormidos = 3 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 730) r where r.alcance = 'conjunto'))::int as perdidos730_deberia_ser_1 from ((select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 730) r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-01', date '2026-06-30', 3, 90, 60, 730) r) union all (select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-01', date '2026-06-30', 3, 90, 60, 730) r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 730) r) union all (select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 730) r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2025-05-27', date '2026-06-30', 3, 90, 60, 730) r) union all (select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2025-05-27', date '2026-06-30', 3, 90, 60, 730) r except all select r.alcance, r.property_id, r.activos, r.dormidos, r.perdidos from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4407', null, date '2026-06-30', date '2026-06-30', 3, 90, 60, 730) r)) d;
rollback;

\echo '=== B25b. el segmento de una sucursal es estable: consultar A2 sola da exactamente las mismas celdas que A2 dentro de la consulta de todas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as seg_estable_deberia_ser_0 from ((select segmento, dow_negocio, hora_local, pedidos, neta_centavos, clientes from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-03-01', date '2026-03-31') except all select segmento, dow_negocio, hora_local, pedidos, neta_centavos, clientes from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where property_id = '00000000-0000-0000-0000-0000000e44a2') union all (select segmento, dow_negocio, hora_local, pedidos, neta_centavos, clientes from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') where property_id = '00000000-0000-0000-0000-0000000e44a2' except all select segmento, dow_negocio, hora_local, pedidos, neta_centavos, clientes from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-03-01', date '2026-03-31'))) d;
rollback;

\echo '=== B26. churn (org F, rango feb-jun): activos al inicio 3 (f1, f2, f4), de los que pasan a perdidos 1 (f1: 171 dias sin pedir); f4 queda dormido (61 dias), f2 activo, f3 perdido de antes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (r.activos_al_inicio = 3 and r.pasan_a_perdidos = 1 and r.activos = 1 and r.dormidos = 1 and r.perdidos = 2)::int as churn_deberia_ser_1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4406', null, date '2026-02-01', date '2026-06-30') r where r.alcance = 'conjunto';
rollback;

\echo '=== B25. segmento por hora: pedidos_por_cliente = pedidos / clientes en cada celda ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (count(*) > 0 and count(*) filter (where pedidos_por_cliente = round(pedidos::numeric / clientes, 2)) = count(*))::int as ppc_seg_deberia_ser_1 from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31');
rollback;

\echo '=== C1. agente A2 dia 10: WhatsApp 3 conversaciones (la demo no), 1 con pedido, 2 con handoff y 3 handoffs; voz 4 llamadas (el preview no): 1 pedido, 1 escalada, 1 abandonada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (wa_conversaciones_nuevas = 3 and wa_con_pedido = 1 and wa_con_handoff = 2 and wa_handoffs = 3 and voz_llamadas = 4 and voz_pedido_creado = 1 and voz_escalado = 1 and voz_abandonado = 1)::int as embudo_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== C2. agente A2 dia 10: voz 190000 + telefonia 25000 micro-USD; la categoria 'voz' (70000) NO se suma; centavos al tipo de cambio 18: 342 + 45 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (costo_voz_micro_usd = 190000 and costo_telefonia_micro_usd = 25000 and costo_voz_centavos = 342 and costo_telefonia_centavos = 45 and mxn_por_usd = 18.0)::int as costos_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== C3. el costo de voz + telefonia de A2 coincide con voz_kpis_diarios (035) del mismo dia (micro-USD, centavos y embudo de voz) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as coincide_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', date '2026-04-10', date '2026-04-10') k, restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') a where a.property_id = '00000000-0000-0000-0000-0000000e44a2' and k.costo_voz_micro_usd = a.costo_voz_micro_usd and k.costo_telefonia_micro_usd = a.costo_telefonia_micro_usd and k.costo_total_centavos_mxn = a.costo_voz_centavos + a.costo_telefonia_centavos and k.llamadas = a.voz_llamadas and k.pedidos_voz = a.voz_pedido_creado and k.escaladas = a.voz_escalado and k.abandonadas = a.voz_abandonado;
rollback;

\echo '=== C4. 0 eventos de Meta (A2 dia 10): meta_eventos = 0 y el costo de Meta es NULL (no medido), nunca 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (meta_eventos = 0 and costo_meta_micro_usd is null and costo_meta_centavos is null)::int as meta_no_medido_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== C5. con eventos de Meta (A2 dia 11): 1 evento, 4000 micro-USD y 7 centavos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (meta_eventos = 1 and costo_meta_micro_usd = 4000 and costo_meta_centavos = 7)::int as meta_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-11', date '2026-04-11') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== C6. sin fx_rate para el dia (20 de marzo): los centavos son NULL aunque hay 9000 micro-USD de telefonia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (costo_telefonia_micro_usd = 9000 and costo_telefonia_centavos is null and costo_voz_centavos is null and mxn_por_usd is null)::int as sin_fx_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-20', date '2026-03-20') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== C7. fila «No asignado» para el owner (organizacion completa): LLM 400000 (solo los roles del agente), telefonia 3000, Meta 1000 con 1 evento; centavos 720 / 5 / 2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (costo_llm_micro_usd = 400000 and costo_telefonia_micro_usd = 3000 and costo_meta_micro_usd = 1000 and meta_eventos = 1 and costo_llm_centavos = 720 and costo_telefonia_centavos = 5 and costo_meta_centavos = 2 and wa_conversaciones_nuevas = 0 and voz_llamadas = 0)::int as no_asignado_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id is null;
rollback;

\echo '=== C8. fila «No asignado» tambien en sesion de sistema (sin usuario) ==='
begin;
set local role authenticated;
select (count(*) = 1)::int as sistema_na_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id is null;
rollback;

\echo '=== C9. el admin acotado a A1 NO ve la fila «No asignado» ni sucursales ajenas (solo A1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4412', true);
select (count(*) filter (where property_id is null) = 0 and count(*) filter (where property_id <> '00000000-0000-0000-0000-0000000e44a1') = 0 and count(*) > 0)::int as acotado_na_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10');
rollback;

\echo '=== C10. el owner que consulta solo A2 tampoco ve «No asignado» (el LLM es de la organizacion, no de la sucursal) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (count(*) = 0)::int as sub_na_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-10') where property_id is null;
rollback;

\echo '=== C11. dia de negocio con corte (A1, 01:00): la llamada de las 00:30 del 11 cuenta en el dia 10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (voz_llamadas = 1 and costo_voz_micro_usd = 7000)::int as corte_voz_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a1';
rollback;

\echo '=== C12. zona horaria (A3 Auckland): la llamada de las 20:00Z del 10 es el 11 local ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (voz_llamadas = 1)::int as auckland_deberia_ser_1 from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-11', date '2026-04-11') where property_id = '00000000-0000-0000-0000-0000000e44a3';
rollback;

\echo '=== C13. escalaciones A2 dia 10 (viernes, dow 5): 7 conversaciones (3 WhatsApp a las 15 + 4 llamadas a las 16) y 4 handoffs (3 de WhatsApp a las 18 + 1 voz escalada a las 16) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (sum(conversaciones) = 7 and sum(handoffs) = 4 and count(*) filter (where dow_negocio <> 5) = 0)::int as esc_deberia_ser_1 from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== C14. escalaciones por hora: a las 15, 3 conversaciones y 0 handoffs; a las 16, 4 y 1; a las 18, 0 y 3 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select conversaciones = 3 and handoffs = 0 from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2' and hora_local = 15) and (select conversaciones = 4 and handoffs = 1 from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2' and hora_local = 16) and (select conversaciones = 0 and handoffs = 3 from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2' and hora_local = 18))::int as esc_hora_deberia_ser_1;
rollback;

\echo '=== D1. entregas A2 dia 10 (promesa 50): 5 entregas (30, 60, 40 completado, 20, 10), 160 minutos y 1 tarde ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (sum(entregados) = 5 and sum(min_suma) = 160 and sum(tarde) = 1)::int as entregas_deberia_ser_1 from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== D2. entregas por hora: 15 -> 2 (90 min, 1 tarde); 16 -> 1 (40 min: el completado cuenta); 17 -> 1 (20); 18 -> 1 (10) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select entregados = 2 and min_suma = 90 and tarde = 1 from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2' and hora_local = 15 and dow_negocio = 5) and (select entregados = 1 and min_suma = 40 from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2' and hora_local = 16) and (select entregados = 1 and min_suma = 20 from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2' and hora_local = 17) and (select entregados = 1 and min_suma = 10 from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2' and hora_local = 18))::int as hora_deberia_ser_1;
rollback;

\echo '=== D3. entregas con promesa de 25 minutos: tardes = 30, 60 y 40 (3) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (sum(tarde) = 3)::int as promesa_deberia_ser_1 from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10', 25) where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== D4. percentiles de entrega A2: p50 = 30 y p90 = 60 (nearest-rank sobre 10, 20, 30, 40, 60) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (p50_min = 30 and p90_min = 60 and entregados = 5)::int as perc_deberia_ser_1 from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== D5. percentiles: el conjunto se calcula sobre todas las entregas (30/60) y las sucursales sin entregas (A1, A3) dan NULL; no son aditivos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select p50_min = 30 and p90_min = 60 and entregados = 5 from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where alcance = 'conjunto') and (select count(*) = 2 from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where alcance = 'sucursal' and entregados = 0 and p50_min is null and p90_min is null))::int as perc_conj_deberia_ser_1;
rollback;

\echo '=== D6. repartidores A2: Repartidor Uno 2 entregas, 90 min, 1 tarde, 1 incidencia (el pedido cancelado no cuenta) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (entregas = 2 and min_suma = 90 and tarde = 1 and incidencias = 1 and nombre = 'Repartidor Uno')::int as rep1_deberia_ser_1 from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2' and repartidor_id = '00000000-0000-0000-0000-0000000e4416';
rollback;

\echo '=== D7. repartidores A2: Repartidor Dos 1 entrega de 40 min (el pedido en camino no cuenta) y 0 incidencias ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (entregas = 1 and min_suma = 40 and tarde = 0 and incidencias = 0 and nombre = 'Repartidor Dos')::int as rep2_deberia_ser_1 from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2' and repartidor_id = '00000000-0000-0000-0000-0000000e4417';
rollback;

\echo '=== D8. repartidores: un repartidor de OTRA organizacion asignado a un pedido sale como '(sin nombre)' y el que no tiene entregas no aparece ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select nombre = '(sin nombre)' from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where repartidor_id = '00000000-0000-0000-0000-0000000e4418') and (select count(*) = 0 from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where repartidor_id = '00000000-0000-0000-0000-0000000e4414'))::int as ajeno_deberia_ser_1;
rollback;

\echo '=== D9. repartidores: solo 7 columnas (id, nombre de staff y conteos); ninguna con telefono, correo ni texto de incidencia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (count(*) = 7 and count(*) filter (where a.n ~* '(telefono|phone|email|correo|nota|note|texto)') = 0)::int as cols_deberia_ser_1 from pg_proc p, unnest(p.proargnames, p.proargmodes) as a(n, m) where p.proname = 'cfo_repartidores' and a.m = 't';
rollback;

\echo '=== D10. colonias A2 (k = 5): Centro con 5 pedidos se muestra: 50000 centavos, 2 entregados, 80 minutos, 5 clientes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (pedidos = 5 and neta_centavos = 50000 and entregados = 2 and min_suma = 80 and clientes = 5)::int as centro_deberia_ser_1 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12') where property_id = '00000000-0000-0000-0000-0000000e44a2' and colonia = 'Centro';
rollback;

\echo '=== D11. colonias: Norte con 4 pedidos se agrupa en '(otras)' (k-anonimato) y no aparece con su nombre ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select pedidos = 4 and clientes = 4 and neta_centavos = 40000 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12') where colonia = '(otras)') and (select count(*) = 0 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12') where colonia = 'Norte'))::int as otras_deberia_ser_1;
rollback;

\echo '=== D12. colonias: lo que no se ubica es '(sin colonia)': cliente sin domicilio guardado, domicilio sin colonia y pedido sin cliente (3 pedidos, 2 clientes) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (pedidos = 3 and clientes = 2)::int as sin_deberia_ser_1 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12') where colonia = '(sin colonia)';
rollback;

\echo '=== D13. colonias con k = 6: Centro (5 pedidos) tambien pasa a '(otras)' (9 pedidos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select pedidos = 9 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12', 6) where colonia = '(otras)'))::int as k6_deberia_ser_1;
rollback;

\echo '=== D14. la sucursal de despacho mas cercana de Centro es A2; '(otras)' y '(sin colonia)' no la llevan ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select count(*) = 1 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12') where colonia = 'Centro' and sucursal_cercana_id = '00000000-0000-0000-0000-0000000e44a2') and (select count(*) = 0 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12') where colonia in ('(otras)', '(sin colonia)') and sucursal_cercana_id is not null))::int as cercana_deberia_ser_1;
rollback;

\echo '=== D15. el admin acotado a A1 no ve colonias de A2 ni su sucursal cercana ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4412', true);
select (count(*) = 0)::int as acotado_col_deberia_ser_1 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12');
rollback;

\echo '=== D15b. k de CLIENTES: Otay tiene 5 pedidos pero de 1 solo cliente: no se muestra y entra a '(otras)' (5 pedidos, 1 cliente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select count(*) = 0 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-13', date '2026-04-13') where colonia = 'Otay') and (select pedidos = 5 and clientes = 1 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-13', date '2026-04-13') where colonia = '(otras)'))::int as otay_deberia_ser_1;
rollback;

\echo '=== D16. colonias: la suma de pedidos por colonia (con otras y sin colonia) es la de los pedidos de domicilio del dia (12) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (sum(pedidos) = 12)::int as col_total_deberia_ser_1 from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12');
rollback;

\echo '=== D17. comandas A2 dia 10: 7 encoladas = 1 confirmada + 2 capturadas a mano + 1 captura manual pendiente + 1 fallida + 2 pendientes/enviadas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (encoladas = 7 and confirmadas = 1 and capturadas_manual = 2 and captura_manual_pendientes = 1 and fallidas = 1 and pendientes_enviadas = 2)::int as estados_deberia_ser_1 from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== D18. comandas: minutos a captura 3 + 8 + 3 = 14 en 3 comandas; vencidas con umbral de 5: la de 8 minutos y la que sigue esperando (2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (min_a_captura_suma = 14 and capturadas_con_tiempo = 3 and vencidas_umbral = 2)::int as tiempo_deberia_ser_1 from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== D19. comandas: 1 folio del POS (confirmada con folio), 1 folio declarado valido ('A-123'; 'nota mala!' no) y el modo vigente 'activo' ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (con_folio_pos = 1 and con_folio_declarado = 1 and modo = 'activo')::int as folios_deberia_ser_1 from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== D20. comandas con modo apagado (organizacion B sin softrestaurant_config): modo 'apagado' y ceros ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4415', true);
select (modo = 'apagado' and encoladas = 0 and confirmadas = 0 and fallidas = 0 and min_a_captura_suma = 0)::int as apagado_deberia_ser_1 from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4402', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44b1';
rollback;

\echo '=== D21. comandas: el umbral de la sucursal se respeta (umbral de 10 minutos: solo la que sigue esperando es vencida) ==='
begin;
insert into restaurantes.pos_comanda_alerta_config (property_id, organization_id, captura_manual_min) values ('00000000-0000-0000-0000-0000000e44a2', '00000000-0000-0000-0000-0000000e4401', 10);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select vencidas_umbral::int as umbral10_deberia_ser_1 from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id = '00000000-0000-0000-0000-0000000e44a2';
rollback;

\echo '=== D22. agotados A2: Taco (agotado sin fecha) vendio 5 unidades en 2 dias de los ultimos 28 (el pedido de hace 40 dias no cuenta); precio 5000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (unidades_28d = 5 and dias_con_venta_28d = 2 and precio_centavos = 5000 and not disponible and agotado_hasta is null)::int as taco_deberia_ser_1 from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null) where property_id = '00000000-0000-0000-0000-0000000e44a2' and product_id = '00000000-0000-0000-0000-0000000e44c1';
rollback;

\echo '=== D23b. agotados: un producto disponible cuyo agotado_hasta ya vencio (hoy) no se lista como agotado, y uno con fecha futura si ==='
begin;
-- A1 tiene corte 01:00: su «hoy» es el DIA DE NEGOCIO ((now() en su zona - corte)::date), que entre 00:00 y 01:00 hora de Mexico (06:00-07:00 UTC)
-- va un dia detras del dia calendario. cfo_agotados compara agotado_hasta contra ese dia de negocio, asi que la fixture usa la MISMA expresion
-- (cfo_zonas, la que usa la funcion) y no el dia calendario: vencido = hoy de negocio (limite: no es > hoy), futuro = hoy de negocio + 2.
insert into restaurantes.branch_products (property_id, product_id, price, is_available, agotado_hasta)
select z.property_id, v.product_id, v.price, true, ((now() at time zone z.tz) - z.corte)::date + v.dias
  from restaurantes.cfo_zonas(array['00000000-0000-0000-0000-0000000e44a1']::uuid[]) z
 cross join (values ('00000000-0000-0000-0000-0000000e44c1'::uuid, 55.00, 0), ('00000000-0000-0000-0000-0000000e44c2'::uuid, 20.00, 2)) as v(product_id, price, dias);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select count(*) = 0 from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null) where property_id = '00000000-0000-0000-0000-0000000e44a1' and product_id = '00000000-0000-0000-0000-0000000e44c1') and (select count(*) = 1 from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null) where property_id = '00000000-0000-0000-0000-0000000e44a1' and product_id = '00000000-0000-0000-0000-0000000e44c2'))::int as vencido_deberia_ser_1;
rollback;

\echo '=== D23. agotados A2: Refresco agotado hasta manana, sin ventas (0, 0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (unidades_28d = 0 and dias_con_venta_28d = 0 and agotado_hasta is not null)::int as refresco_deberia_ser_1 from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null) where property_id = '00000000-0000-0000-0000-0000000e44a2' and product_id = '00000000-0000-0000-0000-0000000e44c2';
rollback;

\echo '=== E1. aditividad cfo_agente_diario: el owner (todas) == A1 + A2 + A3 (la fila «No asignado» es aparte) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as ag_deberia_ser_0 from ((select * from (select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t where property_id is not null except all (select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11'))) union all (select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11') except all select * from (select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t2 where property_id is not null)) d;
rollback;

\echo '=== E2. aditividad cfo_escalaciones_hora: todas == union de las sucursales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as esc_deberia_ser_0 from ((select * from (select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t where property_id is not null except all (select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11'))) union all (select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11') except all select * from (select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t2 where property_id is not null)) d;
rollback;

\echo '=== E3. aditividad cfo_entregas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as ent_deberia_ser_0 from ((select * from (select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t where property_id is not null except all (select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11'))) union all (select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11') except all select * from (select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t2 where property_id is not null)) d;
rollback;

\echo '=== E4. aditividad cfo_repartidores ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as rep_deberia_ser_0 from ((select * from (select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t where property_id is not null except all (select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11'))) union all (select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11') except all select * from (select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t2 where property_id is not null)) d;
rollback;

\echo '=== E5. aditividad cfo_comandas_pos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as com_deberia_ser_0 from ((select * from (select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t where property_id is not null except all (select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11'))) union all (select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11') except all select * from (select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t2 where property_id is not null)) d;
rollback;

\echo '=== E6. aditividad cfo_colonias (k-anonimato por sucursal) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as colo_deberia_ser_0 from ((select * from (select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t where property_id is not null except all (select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11'))) union all (select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11') union all select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-04-10', date '2026-04-11') except all select * from (select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')) t2 where property_id is not null)) d;
rollback;

\echo '=== E7. aditividad cfo_agotados ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as ago_deberia_ser_0 from ((select * from (select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null)) t where property_id is not null except all (select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[]) union all select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[]) union all select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[]))) union all (select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[]) union all select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[]) union all select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[]) except all select * from (select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null)) t2 where property_id is not null)) d;
rollback;

\echo '=== E8. consolidado == Σ sucursales + «No asignado» en el agente: Σ del costo micro-USD y de los embudos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select sum(costo_voz_micro_usd + costo_telefonia_micro_usd + coalesce(costo_meta_micro_usd, 0) + costo_llm_micro_usd + wa_conversaciones_nuevas + voz_llamadas) from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10')) - (select sum(costo_voz_micro_usd + costo_telefonia_micro_usd + coalesce(costo_meta_micro_usd, 0) + costo_llm_micro_usd + wa_conversaciones_nuevas + voz_llamadas) from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id is not null) - (select sum(costo_voz_micro_usd + costo_telefonia_micro_usd + coalesce(costo_meta_micro_usd, 0) + costo_llm_micro_usd + wa_conversaciones_nuevas + voz_llamadas) from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where property_id is null))::int as agente_total_deberia_ser_0;
rollback;

\echo '=== E9. aditividad de pedidos y venta neta por segmento-hora: el total de todas == Σ de A1 + A2 + A3 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select ((select sum(pedidos) || '/' || sum(neta_centavos) from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31')) is not distinct from (select sum(p) || '/' || sum(n) from (select sum(pedidos), sum(neta_centavos) from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-03-01', date '2026-03-31') union all select sum(pedidos), sum(neta_centavos) from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-03-01', date '2026-03-31') union all select sum(pedidos), sum(neta_centavos) from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-03-01', date '2026-03-31')) z(p, n)))::int as seg_adit_deberia_ser_1;
rollback;

\echo '=== E10. clientes: los renglones de sucursal de la llamada completa == los de cada sucursal consultada sola (sus conjuntos son sus propios clientes) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select count(*)::int as clientes_adit_deberia_ser_0 from ((select property_id, clientes_con_pedido, nuevos, recurrentes, activos, dormidos, perdidos, frecuentes, recuperados from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31') r where alcance = 'sucursal') except all (select property_id, clientes_con_pedido, nuevos, recurrentes, activos, dormidos, perdidos, frecuentes, recuperados from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1']::uuid[], date '2026-03-01', date '2026-03-31') r where alcance = 'sucursal' union all select property_id, clientes_con_pedido, nuevos, recurrentes, activos, dormidos, perdidos, frecuentes, recuperados from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-03-01', date '2026-03-31') r where alcance = 'sucursal' union all select property_id, clientes_con_pedido, nuevos, recurrentes, activos, dormidos, perdidos, frecuentes, recuperados from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a3']::uuid[], date '2026-03-01', date '2026-03-31') r where alcance = 'sucursal')) d;
rollback;

\echo '=== F1. RECHAZADO: staff de piso -> 42501 en las 12 funciones (p_props nulo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4413', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', null, 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null)$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F2. RECHAZADO: repartidor -> 42501 en las 12 funciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4414', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', null, 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null)$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F3. RECHAZADO: staff pide una sucursal concreta -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4413', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F4. RECHAZADO: owner de otra organizacion pide la organizacion A (p_props nulo) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4415', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', null, 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null)$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F5. RECHAZADO: owner de otra organizacion pide sucursales de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4415', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F6. RECHAZADO: owner de A declara su organizacion pero pide la sucursal de B -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F7. RECHAZADO: admin acotado a A1 pide A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4412', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F8. RECHAZADO: admin acotado a A1 pide A1 y A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4412', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a1','00000000-0000-0000-0000-0000000e44a2']::uuid[])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F9. RECHAZADO: anon sin execute -> 42501 en las 12 funciones ==='
begin;
set local role anon;
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', null, 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null)$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F10. RECHAZADO: sistema (sin usuario) con una sucursal de otra organizacion -> 42501 ==='
begin;
set local role authenticated;
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], 6)$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[], date '2026-04-10', date '2026-04-11')$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44b1']::uuid[])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== F11. sistema (sin usuario) con p_props nulo ve las 3 sucursales de la organizacion declarada y solo esas ==='
begin;
set local role authenticated;
select (count(distinct property_id) = 3)::int as sistema_deberia_ser_1 from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where alcance = 'sucursal';
rollback;

\echo '=== F12. el owner ve sus 3 sucursales y ninguna ajena; el admin acotado solo A1 (y su conjunto) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (count(*) = 3 and count(*) filter (where property_id in ('00000000-0000-0000-0000-0000000e44b1','00000000-0000-0000-0000-0000000e44c1')) = 0)::int as owner_deberia_ser_1 from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where alcance = 'sucursal';
rollback;

\echo '=== F13. el admin acotado a A1 ve solo A1 en entregas/percentiles ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4412', true);
select (count(*) = 1 and bool_and(property_id = '00000000-0000-0000-0000-0000000e44a1'))::int as admin_deberia_ser_1 from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10') where alcance = 'sucursal';
rollback;

\echo '=== F14. RECHAZADO: rangos y parametros invalidos -> 22023 (rango de 401 dias, invertido, lista vacia o con nulos, k < 5, umbrales, meses) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2025-01-01', date '2026-02-05')$q$,
    $q$select * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2025-01-01', date '2026-02-05')$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2025-01-01', date '2026-02-05')$q$,
    $q$select * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2025-01-01', date '2026-02-05')$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2025-01-01', date '2026-02-05')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2025-01-01', date '2026-02-05')$q$,
    $q$select * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-11', date '2026-04-10')$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12', 4)$q$,
    $q$select * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-12', date '2026-04-12', 0)$q$,
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 0)$q$,
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 3, 90, 60, 60)$q$,
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 3, 400, 60, 120)$q$,
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 3, 90, 366, 400)$q$,
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 3, 90, 60, 731)$q$,
    $q$select * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 3, 366, 60, 120)$q$,
    $q$select * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 3, 366)$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', null, 0)$q$,
    $q$select * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', null, 25)$q$,
    $q$select * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10', 0)$q$,
    $q$select * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-10', 1441)$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array[]::uuid[])$q$,
    $q$select * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2', null]::uuid[])$q$,
    $q$select * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', array(select '00000000-0000-0000-0000-0000000e44a2'::uuid from generate_series(1, 501)), date '2026-04-10', date '2026-04-10')$q$
  ] loop
    perform public.t_esperar_error(v, '22023');
  end loop;
end $$;
select 1 as validacion_ok;
rollback;

\echo '=== F15. un rango de exactamente 400 dias es valido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (count(*) >= 0)::int as rango400_deberia_ser_1 from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2025-01-01', date '2026-02-04');
rollback;

\echo '=== F15b. umbrales alineados con cfo_config (083): activo 365, perdido 730 y frecuente 365 son validos; las 3 combinaciones de borde no fallan ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
select (count(*) = 8)::int as bordes_deberia_ser_1 from (select 1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 3, 365, 365, 730) union all select 1 from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31', 3, 365, 7, 14)) x;
rollback;

\echo '=== F16. RECHAZADO: authenticated no ejecuta los 4 helpers internos -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$select restaurantes.cfo_alcance_org_completo('00000000-0000-0000-0000-0000000e4401')$q$,
    $q$select * from restaurantes.cfo_venta_lean('00000000-0000-0000-0000-0000000e4401', array['00000000-0000-0000-0000-0000000e44a2']::uuid[], date '2026-04-10', date '2026-04-10')$q$,
    $q$select * from restaurantes.cfo_zonas(array['00000000-0000-0000-0000-0000000e44a2']::uuid[])$q$,
    $q$select * from restaurantes.cfo_colonia_cercana('00000000-0000-0000-0000-0000000e4401', 'Centro')$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as helpers_cerrados_ok;
rollback;

\echo '=== F17. sin DML directo (065): authenticated no inserta ni borra pedidos ni clientes ni actualiza comandas -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, items) values ('00000000-0000-0000-0000-0000000e4401', '00000000-0000-0000-0000-0000000e44a2', 'x', '1', 1, '[]')$q$,
    $q$delete from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e4401'$q$,
    $q$update restaurantes.pos_comanda_outbox set estado = 'fallida' where organization_id = '00000000-0000-0000-0000-0000000e4401'$q$,
    $q$delete from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e4401'$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as dml_cerrado_ok;
rollback;

\echo '=== F18. solo lectura: las 12 funciones corren dentro de una transaccion READ ONLY (no escriben nada) ==='
begin;
set transaction read only;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
do $$
begin
  perform * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_clientes_cohortes('00000000-0000-0000-0000-0000000e4401', null, 6);
  perform * from restaurantes.cfo_clientes_altas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_clientes_segmento_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_agente_diario('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_escalaciones_hora('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_entregas('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_entregas_percentiles('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_repartidores('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_colonias('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_comandas_pos('00000000-0000-0000-0000-0000000e4401', null, date '2026-04-10', date '2026-04-11');
  perform * from restaurantes.cfo_agotados('00000000-0000-0000-0000-0000000e4401', null);
end $$;
select 1 as solo_lectura_ok;
rollback;

\echo '=== G1. rendimiento acotado: 20000 pedidos (2000 clientes, 300 colonias y 300 zonas conocidas con coordenadas) en 90 dias; cada una de las 12 funciones responde en menos de 2 s (transaccion con rollback) ==='
begin;
insert into core.organization (id, vertical, name, slug) values ('00000000-0000-0000-0000-0000000e44f1', 'restaurantes', 'CFO2 Perf', 'cfo2-perf');
insert into core.property (id, organization_id, name) values ('00000000-0000-0000-0000-0000000e44f2', '00000000-0000-0000-0000-0000000e44f1', 'Perf');
insert into restaurantes.branch_detail (property_id, organization_id, slug, lat, lng) values ('00000000-0000-0000-0000-0000000e44f2', '00000000-0000-0000-0000-0000000e44f1', 'perf', 21.0, -89.6);
insert into restaurantes.known_zone (organization_id, name, lat, lng) select '00000000-0000-0000-0000-0000000e44f1', 'Colonia ' || g, 20.9 + g / 1000.0, -89.7 + g / 1000.0 from generate_series(0, 299) g;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values ('00000000-0000-0000-0000-0000000e4411', '00000000-0000-0000-0000-0000000e44f1', null, 'owner', 'owner');
insert into restaurantes.customers (id, organization_id, phone, name)
select ('bbbbbbbb-0000-0000-0000-' || lpad(to_hex(g), 12, '0'))::uuid, '00000000-0000-0000-0000-0000000e44f1', '+52 99' || lpad(g::text, 8, '0'), 'c' from generate_series(1, 2000) g;
insert into restaurantes.customer_addresses (customer_id, address, colonia)
select ('bbbbbbbb-0000-0000-0000-' || lpad(to_hex(g), 12, '0'))::uuid, 'calle ' || g, 'Colonia ' || (g % 300) from generate_series(1, 2000) g;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, total, status, items, source, canal, created_at, delivered_at, assigned_repartidor_id)
select '00000000-0000-0000-0000-0000000e44f1', '00000000-0000-0000-0000-0000000e44f2', ('bbbbbbbb-0000-0000-0000-' || lpad(to_hex(1 + (g * 7) % 2000), 12, '0'))::uuid, 'Perf', '+52 5500' || lpad((g % 9000)::text, 6, '0'),
       case when g % 2 = 0 then 'calle ' || (1 + (g * 7) % 2000) end, 100 + (g % 50), 'entregado',
       '[{"id":"00000000-0000-0000-0000-0000000e44c1","name":"Taco","price":50,"quantity":2}]'::jsonb, 'whatsapp', case when g % 2 = 0 then 'domicilio' else 'recoger' end,
       timestamptz '2026-04-01 00:00+00' + (g * interval '389 seconds'), timestamptz '2026-04-01 00:30+00' + (g * interval '389 seconds'),
       case when g % 2 = 0 then '00000000-0000-0000-0000-0000000e4416'::uuid end
  from generate_series(1, 20000) g;
analyze restaurantes.orders; analyze restaurantes.customers; analyze restaurantes.customer_addresses;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4411', true);
do $$
declare
  t0 timestamptz;
  v text;
  n bigint;
  o uuid := '00000000-0000-0000-0000-0000000e44f1';
begin
  foreach v in array array[
    format('select count(*) from restaurantes.cfo_clientes_resumen(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_clientes_cohortes(%L, null, 6)', o),
    format('select count(*) from restaurantes.cfo_clientes_altas(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_clientes_segmento_hora(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_agente_diario(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_escalaciones_hora(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_entregas(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_entregas_percentiles(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_repartidores(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_colonias(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_comandas_pos(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from restaurantes.cfo_agotados(%L, null)', o)
  ] loop
    t0 := clock_timestamp();
    execute v into n;
    if clock_timestamp() - t0 > interval '2 seconds' then
      raise exception 'demasiado lento (%): %', clock_timestamp() - t0, v;
    end if;
  end loop;
  select count(*) into n from restaurantes.cfo_clientes_resumen(o, null, date '2026-04-01', date '2026-06-29') r where r.alcance = 'conjunto' and r.clientes_con_pedido = 2000;
  if n <> 1 then raise exception 'el resumen de rendimiento no devolvio los 2000 clientes'; end if;
end $$;
select 1 as rendimiento_ok;
rollback;

\echo '=== H1. grants: las 12 publicas solo para authenticated (anon y public sin execute); los 4 helpers cerrados a authenticated ==='
begin;
select count(*)::int as grants_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados', 'cfo_alcance_org_completo','cfo_venta_lean','cfo_zonas','cfo_colonia_cercana')
  and ((p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados') and (not has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute')))
    or (p.proname in ('cfo_alcance_org_completo','cfo_venta_lean','cfo_zonas','cfo_colonia_cercana') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))));
rollback;

\echo '=== H2. hay exactamente 16 funciones de la 082 (12 publicas + 4 helpers), sin sobrecargas ==='
begin;
select count(*)::int as funciones_deberia_ser_16 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados', 'cfo_alcance_org_completo','cfo_venta_lean','cfo_zonas','cfo_colonia_cercana');
rollback;

\echo '=== H3. SECURITY DEFINER y search_path fijo (restaurantes, core, pg_temp) en las 16 ==='
begin;
select count(*)::int as postura_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados', 'cfo_alcance_org_completo','cfo_venta_lean','cfo_zonas','cfo_colonia_cercana')
  and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=restaurantes, core, pg_temp'));
rollback;

\echo '=== H4. las 12 funciones publicas son STABLE (solo lectura) ==='
begin;
select count(*)::int as volatilidad_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados') and p.provolatile <> 's';
rollback;

\echo '=== H5. las 12 funciones publicas tienen COMMENT ==='
begin;
select count(*)::int as sin_comentario_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados') and obj_description(p.oid, 'pg_proc') is null;
rollback;

\echo '=== H6. sin PII: ninguna columna de salida de las 12 publicas es nombre, telefono, correo, direccion ni id de cliente (salvo el nombre de staff del repartidor y el del producto) ==='
begin;
select count(*)::int as pii_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(p.proargnames, p.proargmodes) as a(nm, m)
 where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados') and a.m = 't'
   and a.nm ~* '(nombre|name|telefono|phone|email|correo|direccion|address|customer|cliente_id)' and not (p.proname in ('cfo_repartidores', 'cfo_agotados') and a.nm = 'nombre');
rollback;

\echo '=== H7. idempotencia: re-ejecutar las definiciones de las 16 funciones no cambia nada (mismo md5, mismos grants) ==='
begin;
do $$
declare
  r record;
  v_antes text;
  v_despues text;
begin
  select string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text) into v_antes from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados', 'cfo_alcance_org_completo','cfo_venta_lean','cfo_zonas','cfo_colonia_cercana');
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados', 'cfo_alcance_org_completo','cfo_venta_lean','cfo_zonas','cfo_colonia_cercana') order by p.oid loop
    execute pg_get_functiondef(r.oid);
  end loop;
  select string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' order by p.oid::regprocedure::text) into v_despues from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_resumen', 'cfo_clientes_cohortes', 'cfo_clientes_altas', 'cfo_clientes_segmento_hora', 'cfo_agente_diario', 'cfo_escalaciones_hora', 'cfo_entregas', 'cfo_entregas_percentiles', 'cfo_repartidores', 'cfo_colonias', 'cfo_comandas_pos', 'cfo_agotados', 'cfo_alcance_org_completo','cfo_venta_lean','cfo_zonas','cfo_colonia_cercana');
  if v_antes is distinct from v_despues then
    raise exception 'la re-ejecucion cambio las funciones o sus permisos';
  end if;
end $$;
select 1 as idempotente_ok;
rollback;

\echo '=== H8. la 082 no toca las funciones de la 081: siguen cerradas/abiertas como antes (cfo_pedidos_base y cfo_resolver_sucursales sin execute para authenticated; las 7 publicas con execute) ==='
begin;
select count(*)::int as postura081_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes'
  and ((p.proname in ('cfo_pedidos_base','cfo_resolver_sucursales','cfo_renglones','cfo_validar_rango') and has_function_privilege('authenticated', p.oid, 'execute'))
    or (p.proname in ('cfo_ventas_diarias','cfo_cortesias','cfo_ventas_hora','cfo_productos','cfo_canasta_pares','cfo_pedidos_detalle','cfo_cobertura') and not has_function_privilege('authenticated', p.oid, 'execute')));
rollback;

\echo '=== H9. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.cfo_clientes_resumen(uuid, uuid[], date, date, integer, integer, integer, integer);
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.cfo_clientes_resumen('00000000-0000-0000-0000-0000000e4401', null, date '2026-03-01', date '2026-03-31');
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
